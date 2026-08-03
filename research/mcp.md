# MCP servers list + enable/disable (CLI 0.2.113+)

Probe-confirmed on **grok 0.2.118** (Windows native). Extension surface: gear →
Config & debug → **MCP servers**.

## List

| Path | Method / command | Shape |
|---|---|---|
| Live session | `_x.ai/mcp/list` `{ sessionId? }` | `{ result: { servers: [...] } }` (double-wrapped) |
| Config only | `grok mcp list --json` | `[{ name, enabled, scope, command?, args?, url? }]` |
| Push (startup + hot-reload) | `_x.ai/mcp/servers_updated` | `{ mcpServers: [{ name, source, type, command?, args?, url? }] }` |

Session row fields of interest:

```json
{
  "name": "chrome-devtools",
  "source": "local",
  "type": "stdio",
  "command": "npx",
  "args": ["chrome-devtools-mcp@latest"],
  "session": {
    "enabled": true,
    "status": "ready",
    "tools": [{ "name": "click", "description": "…", "enabled": true }]
  }
}
```

Notes:

- Compat-sourced servers (e.g. `~/.claude.json`) appear on the **session** list
  even when `grok mcp list --json` returns `[]`. Prefer the RPC when a live
  process exists; merge CLI rows for `scope` (`user` / `project`).
- Bare `x.ai/mcp/list` is `-32601`. Method is `_`-prefixed.
- Older CLIs: list RPC → `"unsupported"`; fall back to CLI JSON, else panel
  shows “unavailable”.

## Enable / disable

**No ACP RPC** exists (`_x.ai/mcp/enable|disable|set_enabled|…` all `-32601`).

```bash
grok mcp enable  <name>
grok mcp disable <name>
```

- Writes **user** `~/.grok/config.toml`: `disabled_mcp_servers = [...]`, and
  `[mcp_servers.<name>].enabled` when that entry exists.
- **Global side effect** — every Grok session on the machine. The panel must
  state this (`MCP_GLOBAL_SCOPE_WARNING`).
- Works for TOML, compat (Claude/Cursor/`.mcp.json`), and plugin names (see
  CLI user guide § Toggle Servers at Runtime).
- Project sticky `enabled = false` is only cleared on enable; disable never
  rewrites project configs.

Live-session hot-reload after an external CLI toggle is best-effort (file
watchers / leader). The extension always re-lists after enable/disable and
surfaces mid-session rediscovery via the push rails below.

## Push rails (top-level server methods, not `session_notification`)

| Method | Params | Client action |
|---|---|---|
| `_x.ai/mcp/servers_updated` | `{ mcpServers: [...] }` | After first init: “tools refreshed” notice + re-list |
| `_x.ai/mcp/init_progress` | `{ total, connected, sessionId }` | Logged / ignored for UI |
| `_x.ai/mcp_initialized` | `{ sessionId, mcpToolCount, elapsedMs }` | First = silent latch; later = refreshed notice |
| `_x.ai/mcp/server_status` | `{ name, status, reason, … }` | Optional status paint |

Startup order is typically: `servers_updated` → `init_progress` →
`server_status` / `mcp_initialized`. The extension latches
`Session.mcpInitialized` so the startup flood stays quiet.

## Config schema (reference)

```toml
[mcp_servers.my-server]
command = "npx"
args = ["-y", "some-mcp"]
enabled = true

# personal off-list (user config only)
disabled_mcp_servers = ["my-server"]
```

Sources merged by the CLI: config.toml > Claude > Cursor > `.mcp.json`.

## Extension map

| Piece | Role |
|---|---|
| `src/mcp.ts` | Pure parsers / merge / labels / warning copy |
| `src/acp.ts` | `listMcpServers()`, MCP push-rail handlers |
| `src/sidebar.ts` | `refreshMcpServers` / `setMcpServerEnabled` |
| `media/chat.js` | Gear MCP panel + switches |
| `src/protocol.ts` | `mcpServers` / `listMcpServers` / `setMcpServerEnabled` |

Host-local only (remote policy drops the panel messages; AFK Pilot already hides
the Config config/MCP section).
