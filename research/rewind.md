# Rewind ACP surface (P2-9)

Probe-confirmed against **Grok Build CLI 0.2.111** (native Windows) on 2026-07-23.

## Methods (all `_`-prefixed on the wire)

Bare `x.ai/rewind/*` → `-32601 Method not found`. Use `_x.ai/rewind/*`.

| Method | Required params | Response |
|---|---|---|
| `_x.ai/rewind/points` | `sessionId` | `{ rewind_points: RewindPoint[] }` (snake_case fields) |
| `_x.ai/rewind/execute` | `sessionId`, `targetPromptIndex` | see below |

Missing `sessionId` on points → `-32602` with `missing field session_id`.
Missing target on execute → `-32602` `targetPromptIndex or targetResponseId is required`.

### Point row

```jsonc
{
  "prompt_index": 0,
  "created_at": "2026-07-23T03:00:00+00:00",
  "num_file_snapshots": 0,
  "has_file_changes": false,
  "prompt_preview": "Reply with exactly: ok. Do not use tools."
}
```

One point per user prompt. Snapshots live in the session dir as `rewind_points.jsonl`
(file contents); the RPC is the UI-facing summary.

### Execute result

```jsonc
{
  "success": true,
  "target_prompt_index": 1,
  "mode": "all",
  "reverted_files": ["note.txt"],
  "clean_files": [],
  "conflicts": [],
  "prompt_text": "Say B only. No tools.",
  "error": null
}
```

**Modes** (serde enum): `all` | `conversation_only` | `code_only` | `files_only`.
(`code_only` is accepted and echoed as `files_only` on 0.2.111.)

### Force flag is load-bearing

Without `force: true`, execute returns `success: false` with empty arrays and
`error: null` — **no truncation**. The TUI confirmation gate uses this path; the
extension always confirms in VS Code UI, then passes `force: true`.

Without `force: true`, **every** target (including non-tip) returns
`success: false` with empty arrays — that is the TUI confirm gate, not a tip
restriction. With `force: true`, **tip execute succeeds** (probe-confirmed on
0.2.111): sole tip, multi-turn tip, and mid-history targets all work.

### CLI semantics (execute is exclusive)

`execute(target N)` **discards** prompt N and every later turn (remaining
points are `0..N-1`). `prompt_text` is the discarded target's full text — put
it back in the composer for re-edit. The tip is a valid target when
`force: true` (discards only the last turn).

### Disk gap: `updates.jsonl` is not truncated

On 0.2.111, execute updates in-memory rewind state (and may rewrite
`chat_history.jsonl`) but **leaves `updates.jsonl` intact**. `session/load`
replays from `updates.jsonl`, so a naive reload after execute resurrects
discarded bubbles (partial / full history). Extension backstop:
`truncateUpdatesJsonl` / `truncateChatHistoryJsonl` / `truncateRewindPointsJsonl`
in `src/rewind.ts`, applied after dispose and before reload.

## Extension mapping

| UI | Flow |
|---|---|
| **User bubble → Rewind** (primary) | Hover user message → action row (Copy · Rewind · time) → confirm → execute → file restore → dispose → history truncate → reload → **composer prefill** |
| `Grok: Rewind Conversation` (command palette only) | QuickPick fallback (newest first, **tip included**) — **not** in the gear menu |

**Bubble index → wire index:** the hidden plan-mode primer is a real rewind point
(`prompt_index` 0 typically) but never a bubble. `userFacingRewindPoints` /
`resolveUserBubbleRewind` strip primer / system-reminder / marker-only plan
verdicts so bubble `N` maps to the Nth user-facing point. **Every** user bubble
(including the tip) shows Rewind and executes its own wire index (CLI exclusive
semantics + `force: true`). Composer text prefers the bubble's full `_copyText`.

Pure helpers: `src/rewind.ts`. ACP: `AcpClient.listRewindPoints` / `executeRewind`.

## Notes

- Fork (#48) branches **conversation only** — rewind is the complementary feature that restores **file** snapshots.
- After compact, rewinding *before* the compaction checkpoint can fail ("Try rewinding to a prompt after the compaction point instead") — surface `error` as-is.
- Probes: `research/rewind-probe.cjs`, `research/rewind-execute-probe.cjs`, `research/rewind-e2e-probe.cjs`, `research/_rewind-updates-probe.cjs`.

## File restore: CLI delete gap (0.2.111)

On-disk `rewind_points.jsonl` rows carry:

```jsonc
{
  "prompt_index": 1,
  "file_snapshots": { "created.txt": { "path": "created.txt", "content": null } },  // pre-turn
  "after_snapshots": { "created.txt": { "path": "created.txt", "content": "NEW\n" } }
}
```

`content: null` means the file **did not exist** before the turn. Execute restores
modified files via ACP `fs/write_text_file`, lists new files in `reverted_files`,
returns `success: true` — but **never deletes** null-content paths. Disk keeps the
new file. Conversation truncate still works; `rewind_points.jsonl` is **not**
trimmed on execute (later points remain readable for a client backstop).

**Extension backstop** (`computeRewindRestoreActions` + `applyRewindFileRestore` in
`sidebar.ts`): after a successful execute, re-read `rewind_points.jsonl`, for each
file first touched by a discarded turn (`prompt_index >= target`) write the
pre-snapshot body or `unlink` when `content` is null, then revert/close open
editors so dirty buffers can't re-save the discarded edits.
