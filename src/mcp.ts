/**
 * Pure helpers for Grok's MCP surface (CLI 0.2.113+).
 *
 * Wire format (probe-confirmed on CLI 0.2.118 — see research/mcp.md):
 *   list RPC  `_x.ai/mcp/list` { sessionId? }
 *             → { result: { servers: McpServerRecord[] } }  (double-wrapped)
 *   push      `_x.ai/mcp/servers_updated` { mcpServers: [...] }
 *             `_x.ai/mcp/init_progress`   { total, connected, sessionId }
 *             `_x.ai/mcp_initialized`     { sessionId, mcpToolCount, elapsedMs }
 *             `_x.ai/mcp/server_status`   { sessionId, name, status, reason, … }
 *
 * Enable/disable has **no** ACP RPC (-32601). Use the CLI:
 *   `grok mcp enable|disable <name>` → writes user `~/.grok/config.toml`
 *   (`disabled_mcp_servers` + optional `[mcp_servers.<name>].enabled`).
 * That is a **global** side effect — UI must state the scope.
 *
 * Config list (no live session): `grok mcp list --json` → McpCliServer[].
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 */

import { unwrapExtResult } from "./worktree";

/** Global-scope copy shown above the enable/disable switches. */
export const MCP_GLOBAL_SCOPE_WARNING =
  "Enable/disable is global — it updates your user Grok config and applies to every session on this machine.";

/** In-session notice after tools are rediscovered mid-session. */
export function mcpToolsRefreshedNote(toolCount?: number): string {
  if (typeof toolCount === "number" && Number.isFinite(toolCount) && toolCount >= 0) {
    const n = Math.floor(toolCount);
    return n === 1 ? "MCP tools refreshed (1 tool)." : `MCP tools refreshed (${n} tools).`;
  }
  return "MCP tools refreshed.";
}

export interface McpToolInfo {
  name: string;
  description?: string;
  enabled: boolean;
}

/** One MCP server as shown in the gear panel / posted to the webview. */
export interface McpServerView {
  name: string;
  /** Config / session on-off used by the switch. */
  enabled: boolean;
  /** Live session status when known (`initializing` / `ready` / …). */
  status?: string;
  /** Discovery source (`local`, `claude`, …) from the session list. */
  source?: string;
  /** Config scope from `grok mcp list --json` (`user` / `project`). */
  scope?: string;
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  toolCount?: number;
  error?: string;
}

export interface McpListResult {
  servers: McpServerView[];
}

export interface McpServersUpdated {
  servers: McpServerView[];
}

export interface McpInitialized {
  sessionId?: string;
  mcpToolCount: number;
  elapsedMs?: number;
}

export interface McpInitProgress {
  sessionId?: string;
  total: number;
  connected: number;
}

export interface McpServerStatus {
  sessionId?: string;
  name: string;
  source?: string;
  status: string;
  reason?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

function bool(v: unknown, fallback = true): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseTools(v: unknown): McpToolInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const tools: McpToolInfo[] = [];
  for (const raw of v) {
    const t = asRecord(raw);
    if (!t) continue;
    const name = str(t.name).trim();
    if (!name) continue;
    tools.push({
      name,
      description: str(t.description) || undefined,
      enabled: bool(t.enabled, true),
    });
  }
  return tools.length ? tools : undefined;
}

/** Parse one server object from `_x.ai/mcp/list` or a push rail. */
export function parseMcpServerRecord(raw: unknown): McpServerView | null {
  const o = asRecord(raw);
  if (!o) return null;
  const name = str(o.name).trim();
  if (!name) return null;

  const session = asRecord(o.session);
  const tools = session ? parseTools(session.tools) : undefined;
  const sessionEnabled = session ? bool(session.enabled, true) : undefined;
  // Top-level `enabled` appears on CLI JSON and some push shapes; session wins
  // when both are present (live connection state).
  const enabled =
    sessionEnabled !== undefined
      ? sessionEnabled
      : bool(o.enabled, true);

  const toolCount =
    tools?.length ??
    num(o.toolCount) ??
    num(o.tool_count) ??
    (Array.isArray(o.tools) ? o.tools.length : undefined);

  const view: McpServerView = {
    name,
    enabled,
  };
  const status = session ? str(session.status) : str(o.status);
  if (status) view.status = status;
  const source = str(o.source);
  if (source) view.source = source;
  const scope = str(o.scope);
  if (scope) view.scope = scope;
  const type = str(o.type) || str(o.transport);
  if (type) view.type = type;
  const command = str(o.command);
  if (command) view.command = command;
  const args = strArr(o.args);
  if (args) view.args = args;
  const url = str(o.url);
  if (url) view.url = url;
  if (toolCount != null) view.toolCount = toolCount;
  const error = str(o.error) || (session ? str(session.error) : "");
  if (error) view.error = error;
  return view;
}

/**
 * Parse `_x.ai/mcp/list` result. Accepts the double-wrapped `{result:{servers}}`
 * form, a bare `{servers}`, or a raw server array.
 */
export function parseMcpListResult(payload: unknown): McpListResult {
  const unwrapped = unwrapExtResult(payload);
  const root = asRecord(unwrapped);
  const serversRaw = root
    ? (Array.isArray(root.servers) ? root.servers : Array.isArray(unwrapped) ? unwrapped : null)
    : Array.isArray(unwrapped)
      ? unwrapped
      : null;
  if (!serversRaw) return { servers: [] };
  const servers: McpServerView[] = [];
  for (const raw of serversRaw) {
    const s = parseMcpServerRecord(raw);
    if (s) servers.push(s);
  }
  return { servers };
}

/**
 * Parse `grok mcp list --json` stdout. Empty catalog is `[]`; a missing/invalid
 * body yields an empty list (caller decides whether that means "unsupported").
 */
export function parseMcpCliList(stdout: string): McpListResult {
  const text = stdout.trim();
  if (!text) return { servers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { servers: [] };
  }
  if (!Array.isArray(parsed)) {
    // Some builds may wrap as `{servers:[…]}`.
    return parseMcpListResult(parsed);
  }
  const servers: McpServerView[] = [];
  for (const raw of parsed) {
    const s = parseMcpServerRecord(raw);
    if (s) servers.push(s);
  }
  return { servers };
}

/** Parse `_x.ai/mcp/servers_updated` params. */
export function parseMcpServersUpdated(params: unknown): McpServersUpdated | null {
  const o = asRecord(params);
  if (!o) return null;
  const list = o.mcpServers ?? o.servers;
  if (!Array.isArray(list)) return null;
  const servers: McpServerView[] = [];
  for (const raw of list) {
    const s = parseMcpServerRecord(raw);
    if (s) servers.push(s);
  }
  return { servers };
}

/** Parse `_x.ai/mcp_initialized` params. */
export function parseMcpInitialized(params: unknown): McpInitialized | null {
  const o = asRecord(params);
  if (!o) return null;
  const count = num(o.mcpToolCount) ?? num(o.mcp_tool_count);
  if (count == null) return null;
  const out: McpInitialized = { mcpToolCount: count };
  const sid = str(o.sessionId) || str(o.session_id);
  if (sid) out.sessionId = sid;
  const elapsed = num(o.elapsedMs) ?? num(o.elapsed_ms);
  if (elapsed != null) out.elapsedMs = elapsed;
  return out;
}

/** Parse `_x.ai/mcp/init_progress` params. */
export function parseMcpInitProgress(params: unknown): McpInitProgress | null {
  const o = asRecord(params);
  if (!o) return null;
  const total = num(o.total);
  const connected = num(o.connected);
  if (total == null || connected == null) return null;
  const out: McpInitProgress = { total, connected };
  const sid = str(o.sessionId) || str(o.session_id);
  if (sid) out.sessionId = sid;
  return out;
}

/** Parse `_x.ai/mcp/server_status` params. */
export function parseMcpServerStatus(params: unknown): McpServerStatus | null {
  const o = asRecord(params);
  if (!o) return null;
  const name = str(o.name).trim();
  const status = str(o.status).trim();
  if (!name || !status) return null;
  const out: McpServerStatus = { name, status };
  const sid = str(o.sessionId) || str(o.session_id);
  if (sid) out.sessionId = sid;
  const source = str(o.source);
  if (source) out.source = source;
  const reason = str(o.reason);
  if (reason) out.reason = reason;
  return out;
}

/**
 * Merge a session list (ACP) with a config list (CLI). Session rows win on
 * status/tools; CLI rows supply scope + a config `enabled` when the session
 * omits a server (disabled-before-connect).
 */
export function mergeMcpServerLists(
  session: readonly McpServerView[],
  config: readonly McpServerView[],
): McpServerView[] {
  const byName = new Map<string, McpServerView>();
  for (const s of config) {
    byName.set(s.name, { ...s });
  }
  for (const s of session) {
    const prev = byName.get(s.name);
    byName.set(s.name, {
      ...prev,
      ...s,
      // Prefer session enabled/status; keep CLI scope when session has none.
      scope: s.scope || prev?.scope,
      enabled: s.enabled,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One-line subtitle under a server name in the gear panel. */
export function mcpServerDetail(server: McpServerView): string {
  const bits: string[] = [];
  if (server.scope === "project") bits.push("project");
  else if (server.scope === "user") bits.push("user");
  if (server.source && server.source !== "local") bits.push(server.source);
  if (server.status) bits.push(server.status);
  if (typeof server.toolCount === "number" && server.toolCount > 0) {
    bits.push(server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`);
  }
  if (server.url) bits.push(server.url);
  else if (server.command) {
    const args = server.args?.length ? ` ${server.args.join(" ")}` : "";
    const cmd = `${server.command}${args}`.trim();
    bits.push(cmd.length > 48 ? cmd.slice(0, 45) + "…" : cmd);
  }
  if (server.error) bits.push(server.error);
  return bits.join(" · ");
}

/** True when a server method name is an MCP push rail the client should handle. */
export function isMcpServerMethod(method: string): boolean {
  return (
    method === "_x.ai/mcp/servers_updated" ||
    method === "x.ai/mcp/servers_updated" ||
    method === "_x.ai/mcp_initialized" ||
    method === "x.ai/mcp_initialized" ||
    method === "_x.ai/mcp/init_progress" ||
    method === "x.ai/mcp/init_progress" ||
    method === "_x.ai/mcp/server_status" ||
    method === "x.ai/mcp/server_status"
  );
}
