/**
 * Pure helpers for Grok's rewind surface (`_x.ai/rewind/*`).
 *
 * Wire format (probe-confirmed on CLI 0.2.111 — see research/rewind.md):
 *   points  { sessionId } → { rewind_points: RewindPoint[] }  (snake_case fields)
 *   execute { sessionId, targetPromptIndex, mode?, force? }
 *           → { success, target_prompt_index, mode, reverted_files, clean_files,
 *               conflicts, prompt_text, error }
 *
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 * `force: true` is required for the execute to actually truncate (without it
 * the CLI returns success:false with empty arrays — the TUI confirmation gate).
 *
 * **CLI semantics (0.2.111):** execute(target N) **discards** prompt N and every
 * later turn (exclusive — remaining points are `0..N-1`). `prompt_text` is the
 * discarded target's full text (for the composer). With `force: true`, the tip
 * is a valid target (discards only the last turn).
 *
 * **Disk gap:** execute updates in-memory state + often `chat_history.jsonl`, but
 * **does not truncate `updates.jsonl`**, which `session/load` replays — so a
 * post-rewind reload can resurrect discarded turns. Client backstop:
 * `truncateUpdatesJsonl` / `truncateChatHistoryJsonl` / `truncateRewindPointsJsonl`.
 *
 * User-bubble mapping: the extension's hidden primer (and other non-bubbled
 * turns) still create rewind points. `userFacingRewindPoints` strips those so
 * the Nth visible user bubble aligns with the Nth user-facing point.
 */

import { isPrimerText } from "./grok-primer";
import { unwrapExtResult } from "./worktree";

/** Modes the execute RPC accepts (serde enum on the wire). */
export type RewindMode = "all" | "conversation_only" | "code_only" | "files_only";

export const REWIND_MODES: readonly RewindMode[] = [
  "all",
  "conversation_only",
  "code_only",
  "files_only",
];

export interface RewindPoint {
  promptIndex: number;
  createdAt: string;
  numFileSnapshots: number;
  hasFileChanges: boolean;
  promptPreview: string;
}

export interface RewindExecuteResult {
  success: boolean;
  targetPromptIndex: number;
  mode: RewindMode | string;
  revertedFiles: string[];
  cleanFiles: string[];
  conflicts: unknown[];
  promptText: string | null;
  error: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Parse one rewind point row (snake_case wire → camelCase). */
export function parseRewindPoint(raw: unknown): RewindPoint | null {
  const r = asRecord(raw);
  if (!r) return null;
  const promptIndex =
    typeof r.prompt_index === "number"
      ? r.prompt_index
      : typeof r.promptIndex === "number"
        ? r.promptIndex
        : null;
  if (promptIndex == null || !Number.isFinite(promptIndex) || promptIndex < 0) return null;
  return {
    promptIndex,
    createdAt: str(r.created_at || r.createdAt),
    numFileSnapshots: num(r.num_file_snapshots ?? r.numFileSnapshots, 0),
    hasFileChanges: r.has_file_changes === true || r.hasFileChanges === true,
    promptPreview: str(r.prompt_preview || r.promptPreview),
  };
}

/**
 * Parse `_x.ai/rewind/points` result. Accepts bare `{rewind_points:[…]}`, a
 * double-wrapped `{result:{…}}`, or a bare array of points.
 */
export function parseRewindPoints(payload: unknown): RewindPoint[] {
  const unwrapped = unwrapExtResult(payload);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
  }
  const r = asRecord(unwrapped);
  if (!r) return [];
  const list = r.rewind_points ?? r.rewindPoints ?? r.points;
  if (!Array.isArray(list)) return [];
  return list.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
}

/** Parse `_x.ai/rewind/execute` result. */
export function parseRewindExecute(payload: unknown): RewindExecuteResult | null {
  const r = asRecord(unwrapExtResult(payload));
  if (!r) return null;
  // success is required for a real execute response; if absent, treat as unparseable.
  if (typeof r.success !== "boolean") return null;
  const modeRaw = str(r.mode, "all");
  return {
    success: r.success,
    targetPromptIndex: num(r.target_prompt_index ?? r.targetPromptIndex, 0),
    mode: modeRaw,
    revertedFiles: strArr(r.reverted_files ?? r.revertedFiles),
    cleanFiles: strArr(r.clean_files ?? r.cleanFiles),
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    promptText:
      typeof r.prompt_text === "string"
        ? r.prompt_text
        : typeof r.promptText === "string"
          ? r.promptText
          : null,
    error:
      typeof r.error === "string"
        ? r.error
        : r.error == null
          ? null
          : String(r.error),
  };
}

/**
 * Format a rewind point for a QuickPick label.
 * Newest-first callers reverse the list themselves; this only formats one row.
 */
export function formatRewindPointLabel(p: RewindPoint): string {
  const preview = (p.promptPreview || "(empty prompt)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 72 ? preview.slice(0, 69) + "…" : preview;
  const files = p.hasFileChanges
    ? ` · ${p.numFileSnapshots || "?"} file${p.numFileSnapshots === 1 ? "" : "s"}`
    : "";
  return `#${p.promptIndex}  ${clipped}${files}`;
}

/** QuickPick detail line (timestamp). */
export function formatRewindPointDetail(p: RewindPoint): string | undefined {
  if (!p.createdAt) return undefined;
  try {
    const d = new Date(p.createdAt);
    if (Number.isNaN(d.getTime())) return p.createdAt;
    return d.toLocaleString();
  } catch {
    return p.createdAt;
  }
}

/**
 * Points that are valid rewind *targets* for the QuickPick path.
 *
 * With `force: true` (what the extension always sends), **every** point is a
 * valid execute target — including the tip (latest prompt). CLI exclusive
 * semantics: execute(N) discards N and later; tip execute discards only the
 * last turn. Filter with `userFacingRewindPoints` first when picking among
 * user bubbles. Empty input → [].
 */
export function selectableRewindPoints(points: RewindPoint[]): RewindPoint[] {
  // Chronological order; UI may reverse for newest-first display.
  return points.slice();
}

/**
 * True when a rewind point is extension/CLI plumbing that never renders a
 * user bubble — so it must not occupy a slot in the bubble→point map.
 * Mirrors chat.js / `countsAsUserBubble` for previews (truncated OK for primer).
 */
export function isHiddenRewindPoint(p: RewindPoint): boolean {
  const t = p.promptPreview ?? "";
  if (isPrimerText(t)) return true;
  if (/^\s*<system-reminder>/.test(t)) return true;
  // Marker-only plan verdict (no user comment) — no bubble.
  if (/^\s*\[Plan (approved|rejected|cancelled)\]\s*$/i.test(t.trim())) return true;
  return false;
}

/**
 * Rewind points that correspond 1:1 with visible user bubbles (order preserved).
 * The Nth user bubble → `userFacingRewindPoints(all)[N]`.
 */
export function userFacingRewindPoints(points: RewindPoint[]): RewindPoint[] {
  return points.filter((p) => !isHiddenRewindPoint(p));
}

/**
 * Result of mapping a visible user bubble to a wire rewind execute target.
 *
 * Execute *this* wire index — CLI discards this turn and everything after;
 * `prompt_text` is this message. With `force: true`, the tip is a valid target
 * (discards only the last turn). `undoingTip` is retained for confirm/composer
 * helpers but is no longer set by the resolver (legacy primer workaround).
 */
export interface UserBubbleRewind {
  /** Wire target for `_x.ai/rewind/execute`. */
  execute: RewindPoint;
  /** The user-facing bubble the user clicked (confirm preview + composer). */
  bubble: RewindPoint;
  undoingTip: boolean;
}

/**
 * Map a 0-based visible user-bubble index to a rewind target.
 *
 * Every user-facing bubble (including the tip) maps to its own wire index.
 * CLI exclusive semantics + `force: true`: execute(N) discards N and later.
 * `allPoints` is the full list from `/points` (primer included) so
 * `userFacingRewindPoints` can strip hidden plumbing.
 */
export function resolveUserBubbleRewind(
  allPoints: RewindPoint[],
  userBubbleIndex: number,
): UserBubbleRewind | null {
  if (!Number.isInteger(userBubbleIndex) || userBubbleIndex < 0) return null;
  if (allPoints.length === 0) return null;
  const facing = userFacingRewindPoints(allPoints);
  const bubble = facing[userBubbleIndex];
  if (!bubble) return null;
  return { execute: bubble, bubble, undoingTip: false };
}

/**
 * Text to put in the composer after a successful rewind.
 *
 * Prefer the bubble's full text (webview `_copyText`). Fall back to execute's
 * `prompt_text` only when not undoing via a prior checkpoint — undoing the tip
 * through the primer returns the primer text on the wire, which must never
 * land in the composer.
 */
export function rewindComposerText(opts: {
  bubbleText?: string | null;
  promptText?: string | null;
  promptPreview?: string | null;
  undoingTip?: boolean;
}): string {
  const fromBubble = String(opts.bubbleText ?? "").trim();
  if (fromBubble) return fromBubble;
  if (!opts.undoingTip) {
    const fromResult = String(opts.promptText ?? "").trim();
    if (fromResult && !isPrimerText(fromResult) && !/^\s*<system-reminder>/.test(fromResult)) {
      return fromResult;
    }
  }
  const preview = String(opts.promptPreview ?? "").trim();
  if (preview && !isPrimerText(preview)) return preview;
  return "";
}

/** Nearest rewind point strictly before `promptIndex`, or null. */
export function previousRewindPoint(
  allPoints: RewindPoint[],
  promptIndex: number,
): RewindPoint | null {
  let best: RewindPoint | null = null;
  for (const p of allPoints) {
    if (p.promptIndex >= promptIndex) continue;
    if (!best || p.promptIndex > best.promptIndex) best = p;
  }
  return best;
}

/** Confirm dialog body for a chosen target. */
export function rewindConfirmMessage(
  p: RewindPoint,
  mode: RewindMode = "all",
  opts?: { undoingTip?: boolean },
): string {
  const preview = (p.promptPreview || "(empty)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
  if (opts?.undoingTip) {
    const scope =
      mode === "conversation_only"
        ? "This turn will be discarded from the conversation and its text put back in the composer."
        : mode === "files_only" || mode === "code_only"
          ? "Files will be restored to their snapshot before this turn; conversation stays."
          : "This turn will be discarded, files restored to their snapshot before it, and the text put back in the composer.";
    return (
      `Discard this turn?\n\n` +
      `"${clipped}"\n\n` +
      `${scope}\n` +
      `This cannot be undone (unless you have the changes in git).`
    );
  }
  const scope =
    mode === "conversation_only"
      ? "This message and everything after it will be discarded; the text is put back in the composer."
      : mode === "files_only" || mode === "code_only"
        ? "Files will be restored to their snapshot before this turn; conversation stays."
        : "This message and everything after it will be discarded, files restored, and the text put back in the composer.";
  return (
    `Rewind from this message?\n\n` +
    `"${clipped}"\n\n` +
    `${scope}\n` +
    `This cannot be undone (unless you have the changes in git).`
  );
}

// ─── Disk snapshot restore backstop ──────────────────────────────────────────
//
// The CLI's `_x.ai/rewind/execute` restores modified files via ACP
// `fs/write_text_file`, but **does not delete** files whose pre-turn snapshot
// is `content: null` (file did not exist). It still lists them in
// `reverted_files` and returns `success: true` — so the UI says "Restored N
// files" while new files remain on disk. Probe-confirmed on 0.2.111
// (`research/rewind-e2e-probe.cjs`).
//
// The on-disk `rewind_points.jsonl` carries the authoritative pre/post
// snapshots. After a successful execute we re-apply the plan client-side:
// write restored content, delete null-content paths, then sync open editors.

/** One file entry inside a disk rewind point's snapshot maps. */
export interface RewindDiskFileSnap {
  /** Relative (or absolute) path as stored on the wire. */
  path: string;
  /** File body before/after the turn. `null` = file did not exist. */
  content: string | null;
}

/** One line of `rewind_points.jsonl` (subset we need for restore). */
export interface RewindDiskPoint {
  promptIndex: number;
  /** Pre-turn snapshots (key = relative path as stored by the CLI). */
  fileSnapshots: Record<string, RewindDiskFileSnap>;
  /** Post-turn snapshots (unused for restore plan; kept for completeness). */
  afterSnapshots: Record<string, RewindDiskFileSnap>;
}

/** A single filesystem action to bring the workspace back to the target turn. */
export type RewindRestoreAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string };

function parseDiskFileSnap(key: string, raw: unknown): RewindDiskFileSnap | null {
  const r = asRecord(raw);
  if (!r) return null;
  const p = typeof r.path === "string" && r.path ? r.path : key;
  // Explicit null means "did not exist". Missing content treated as null too
  // (older/partial rows). A real empty file is content: "".
  if (!("content" in r) || r.content === null || r.content === undefined) {
    return { path: p, content: null };
  }
  if (typeof r.content !== "string") return null;
  return { path: p, content: r.content };
}

function parseDiskSnapMap(raw: unknown): Record<string, RewindDiskFileSnap> {
  const r = asRecord(raw);
  if (!r) return {};
  const out: Record<string, RewindDiskFileSnap> = {};
  for (const [k, v] of Object.entries(r)) {
    const snap = parseDiskFileSnap(k, v);
    if (snap) out[k] = snap;
  }
  return out;
}

/** Parse one `rewind_points.jsonl` line (or object). */
export function parseRewindDiskPoint(raw: unknown): RewindDiskPoint | null {
  const r = asRecord(raw);
  if (!r) return null;
  const promptIndex =
    typeof r.prompt_index === "number"
      ? r.prompt_index
      : typeof r.promptIndex === "number"
        ? r.promptIndex
        : null;
  if (promptIndex == null || !Number.isFinite(promptIndex) || promptIndex < 0) return null;
  return {
    promptIndex,
    fileSnapshots: parseDiskSnapMap(r.file_snapshots ?? r.fileSnapshots),
    afterSnapshots: parseDiskSnapMap(r.after_snapshots ?? r.afterSnapshots),
  };
}

/** Parse the full `rewind_points.jsonl` file text into disk points. */
export function parseRewindPointsJsonl(text: string): RewindDiskPoint[] {
  if (!text || typeof text !== "string") return [];
  const out: RewindDiskPoint[] = [];
  for (const line of text.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const p = parseRewindDiskPoint(JSON.parse(t));
      if (p) out.push(p);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/**
 * Compute the file restore plan for execute(target N) — CLI **discards** turn N
 * and every later turn, so files return to their state *before* turn N.
 *
 * For each file first touched by the discarded range (`prompt_index >= N`), the
 * pre-turn snapshot on that earliest discarded point is the restore target:
 *   - `content: null` → delete the file (it did not exist then)
 *   - `content: string` → write that body back
 *
 * Files only modified before N are left alone.
 */
export function computeRewindRestoreActions(
  points: RewindDiskPoint[],
  targetPromptIndex: number,
): RewindRestoreAction[] {
  if (!Number.isFinite(targetPromptIndex)) return [];
  // Inclusive: discard N and after (matches CLI exclusive conversation truncate).
  const discarded = points
    .filter((p) => p.promptIndex >= targetPromptIndex)
    .sort((a, b) => a.promptIndex - b.promptIndex);
  // path → restore content (null = delete). First (earliest) discarded point wins.
  const byPath = new Map<string, string | null>();
  for (const p of discarded) {
    for (const snap of Object.values(p.fileSnapshots)) {
      const key = snap.path || "";
      if (!key || byPath.has(key)) continue;
      byPath.set(key, snap.content);
    }
  }
  const actions: RewindRestoreAction[] = [];
  for (const [filePath, content] of byPath) {
    if (content === null) actions.push({ kind: "delete", path: filePath });
    else actions.push({ kind: "write", path: filePath, content });
  }
  // Stable order: deletes first (so a rewrite of the same path later can't
  // race), then writes — sorted by path within each kind for testability.
  actions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "delete" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return actions;
}

/**
 * Resolve a snapshot path against the session cwd. Absolute paths (incl.
 * Windows drive letters) pass through; relative paths join the cwd.
 */
export function resolveRewindWorkspacePath(cwd: string, snapPath: string): string {
  if (!snapPath) return cwd;
  // Absolute POSIX or Windows (C:\…, \\server\share, /tmp/…)
  if (
    snapPath.startsWith("/") ||
    snapPath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(snapPath)
  ) {
    return snapPath;
  }
  // Avoid importing node:path here — keep the module pure + browser-safe for
  // tests. Snapshot paths use `\` on Windows and `/` elsewhere; normalize
  // separators when joining.
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const rel = snapPath.replace(/[\\/]+/g, sep);
  const base = cwd.endsWith("\\") || cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base + sep + rel;
}

/** Summarize restore actions for logs / toasts. */
export function summarizeRewindRestoreActions(actions: RewindRestoreAction[]): {
  written: number;
  deleted: number;
  paths: string[];
} {
  let written = 0;
  let deleted = 0;
  const paths: string[] = [];
  for (const a of actions) {
    paths.push(a.path);
    if (a.kind === "write") written++;
    else deleted++;
  }
  return { written, deleted, paths };
}

// ─── History truncate backstop (updates.jsonl gap) ───────────────────────────
//
// CLI execute discards turns in-memory and may rewrite chat_history, but
// `updates.jsonl` (what `session/load` replays) is left intact — a reload after
// rewind resurrects discarded user/agent bubbles. Truncate client-side to
// match execute(target N) ≡ keep prompts with index < N.

function splitJsonlLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/^\uFEFF/, "").split(/\n/).filter((l) => l.trim().length > 0);
}

/**
 * Truncate `updates.jsonl` so only turns with prompt index `< target` remain.
 * Counts each `user_message_chunk` as the start of the next prompt (0-based).
 * Non-JSON / non-update lines are kept until the cut.
 */
export function truncateUpdatesJsonl(text: string, targetPromptIndex: number): string {
  if (!Number.isFinite(targetPromptIndex) || targetPromptIndex < 0) return text;
  const lines = splitJsonlLines(text);
  const kept: string[] = [];
  let userPromptCount = 0;
  for (const line of lines) {
    let su: string | undefined;
    try {
      const j = JSON.parse(line) as { params?: { update?: { sessionUpdate?: string } } };
      su = j.params?.update?.sessionUpdate;
    } catch {
      kept.push(line);
      continue;
    }
    if (su === "user_message_chunk") {
      if (userPromptCount >= targetPromptIndex) break;
      userPromptCount++;
    }
    kept.push(line);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * Truncate `chat_history.jsonl` at the first user row with
 * `prompt_index >= target` (that row and everything after are dropped).
 * Rows without `prompt_index` (system / synthetic) before the cut stay.
 */
export function truncateChatHistoryJsonl(text: string, targetPromptIndex: number): string {
  if (!Number.isFinite(targetPromptIndex) || targetPromptIndex < 0) return text;
  const lines = splitJsonlLines(text);
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as { type?: string; prompt_index?: unknown };
      if (
        j.type === "user" &&
        typeof j.prompt_index === "number" &&
        Number.isFinite(j.prompt_index) &&
        j.prompt_index >= targetPromptIndex
      ) {
        break;
      }
    } catch {
      // keep corrupt lines until we know better
    }
    kept.push(line);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * Truncate `rewind_points.jsonl` to points with `prompt_index < target`.
 */
export function truncateRewindPointsJsonl(text: string, targetPromptIndex: number): string {
  if (!Number.isFinite(targetPromptIndex) || targetPromptIndex < 0) return text;
  const kept: string[] = [];
  for (const line of splitJsonlLines(text)) {
    try {
      const j = JSON.parse(line) as { prompt_index?: unknown; promptIndex?: unknown };
      const idx =
        typeof j.prompt_index === "number"
          ? j.prompt_index
          : typeof j.promptIndex === "number"
            ? j.promptIndex
            : null;
      if (idx != null && idx >= targetPromptIndex) continue;
    } catch {
      // keep unparseable
    }
    kept.push(line);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}
