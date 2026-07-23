/**
 * Pure helpers for `/btw` side questions (P3-16).
 *
 * Mid-session asides that do **not** cancel or steer the main turn — distinct
 * from `#52` Steer (`_x.ai/interject`). Wire (grok 0.2.111):
 *
 *   → `_x.ai/btw` `{ sessionId, question }`
 *   ← JSON-RPC result `{ result: { answer } }` (double-wrapped; bare
 *     `{ answer }` accepted as a future-proof flat shape)
 *
 * Answer arrives only on the RPC result (not as `agent_message_chunk` on the
 * parent session). Persist: session `btw_history.jsonl`. Probe:
 * `research/btw-probe.cjs` / `research/btw.md`.
 */

/** Slash name the CLI advertises for side questions. */
export const BTW_SLASH_NAME = "btw";

/**
 * Parse a leading `/btw` command from composer/send text.
 * Returns `null` when the text is not a btw slash; `{ question: "" }` when the
 * command is present but has no body (`/btw` / `/btw `).
 */
export function parseBtwSlash(text: string): { question: string } | null {
  const t = String(text ?? "").trim();
  // Same leading-token shape as matchSlashCommand, scoped to the btw name.
  // Body may be multi-line; trailing whitespace is stripped from the question.
  const m = t.match(/^\/btw(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { question: (m[1] ?? "").trim() };
}

/** True when `text` is a `/btw` command (with or without a question body). */
export function isBtwSlash(text: string): boolean {
  return parseBtwSlash(text) != null;
}

/**
 * Pull the answer string out of an `_x.ai/btw` JSON-RPC result.
 *
 * On 0.2.111 the result is double-wrapped: `{ result: { answer: "…" } }`
 * (the outer `result` is JSON-RPC's result field; the inner is the CLI's
 * payload envelope). Also accepts a flat `{ answer }` in case a later build
 * drops the nest.
 */
export function extractBtwAnswer(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.answer === "string") return r.answer;
  const inner = r.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const a = (inner as Record<string, unknown>).answer;
    if (typeof a === "string") return a;
  }
  return undefined;
}

/** Usage hint when the user types bare `/btw` with no question. */
export const BTW_USAGE = "Usage: /btw <question>";
