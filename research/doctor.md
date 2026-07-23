# Doctor diagnostics (extension surface)

## What the CLI does

Since **0.2.109**, Grok Build ships:

| Surface | Role |
|---|---|
| `grok doctor` / `grok doctor --json` | Standalone, read-only terminal/env report (no TUI) |
| `/doctor` (aliases: `/terminal-setup`, `/terminal-check`, `/terminal-info`) | Same facts **inside** the TUI pager, plus runtime-only evidence (Kitty flags, fullscreen, sandbox, …) |

`/doctor` is a **pager builtin** (xai-grok-pager). It is **not** advertised over ACP `available_commands_update` (probe 0.2.111: command list has no `doctor`).

## Extension approach

The extension does **not** try to drive the TUI slash over `session/prompt`. It:

1. Spawns `grok doctor --json` via `execFile` (`DOCTOR_CLI_ARGS` in `src/doctor.ts`)
2. Parses with `parseDoctorJson` → formats with `formatDoctorReport` / `formatDoctorSummary`
3. Writes the full report to the **Grok** Output channel and shows it
4. Posts a compact `doctorReport` card to the webview (summary + **Show full report** — expands the report in chat *and* reveals the Grok Output channel; a dead Output-only click was easy to miss from the secondary side bar)

Entry points:

- Composer `/doctor` (and the three aliases) — intercepted like `/btw`, never a main turn
- Gear → **Config & debug** → **Run doctor diagnostics**
- Command palette **Grok: Doctor (Diagnostics)**

## JSON shape (0.2.111 sample)

```json
{
  "schemaVersion": "1",
  "facts": {
    "terminal": { "name": "vs_code", "xtversion": { "status": "unavailable", "value": null } },
    "multiplexer": { "kind": "undetected", "byobu": null },
    "ssh": false,
    "color": { "level": { "status": "available", "value": "truecolor" }, "availableThemes": [...], "totalThemes": 5 },
    "newline": { "kind": "xterm_js", "terminalName": "vs_code" },
    "clipboard": { "nativeRoute": true, "nativeTool": "arboard", "delivery": "confirmed", ... },
    "voice": { "status": "available", "name": "...", "detail": "..." }
  },
  "findings": [],
  "probeNotes": [{ "probe": "runtime.fullscreen-active", "status": "unavailable", "message": null }],
  "counts": { "issues": 0, "recommendations": 0, "probeNotes": 3 }
}
```

Standalone doctor **cannot** fill live-TUI probe notes; those stay `unavailable` and the formatted report points users at the standalone TUI for that evidence.

## Out of scope (this slice)

- Session **export / share**
- Folder-trust prompts
- Applying `grok doctor fix <id>` remediations from the extension UI

## Related

- User guide: `~/.grok/docs/user-guide/21-terminal-support.md`, `04-slash-commands.md` § `/doctor`
- Pure module: `src/doctor.ts`
- Host: `GrokSidebar.runDoctor` in `src/sidebar.ts`
