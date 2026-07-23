export interface SlashCmd {
  name: string;
  description?: string;
}

/**
 * Slash commands the extension owns (not advertised by the CLI over ACP).
 * Injected at the same ingestion point as `filterAdvertisedCommands` so they
 * appear in autocomplete and the dispatch name list.
 *
 * - `/btw` (P3-16) — unadvertised `_x.ai/btw` RPC
 * - `/doctor` (P3-20) — TUI pager builtin; extension runs standalone
 *   `grok doctor --json` instead (aliases match via `isDoctorSlash`, only
 *   the primary name is injected so the `/` popover stays short)
 */
export const EXTENSION_SLASH_COMMANDS: readonly SlashCmd[] = [
  {
    name: "btw",
    description: "Side question — does not interrupt the main turn",
  },
  {
    name: "doctor",
    description: "Terminal & environment diagnostics (also gear → Config & debug)",
  },
];

/**
 * Slash commands the extension hides from both the autocomplete list and the
 * dispatch gate. `/always-approve` (#31) only mutates grok's *global*
 * config.toml — a surprising, sticky side effect that then silences permission
 * cards in every grok session — and is a no-op over ACP anyway. `/context`
 * (#39) renders only in the CLI's own TUI: over ACP stdio it streams nothing
 * back, so selecting it silently does nothing (`/session-info` is the working
 * equivalent). Filtered at ingestion (see `filterAdvertisedCommands`).
 */
export const HIDDEN_SLASH_COMMANDS: ReadonlySet<string> = new Set(["always-approve", "context"]);

/** Slash names for image generation (hidden when `[features] image_gen` is off). */
export const IMAGE_GEN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "imagine",
  "imagine-edit",
]);

/** Slash names for video generation (hidden when `[features] video_gen` is off). */
export const VIDEO_GEN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "imagine-video",
]);

export interface FilterAdvertisedOptions {
  /** When false, drop `/imagine` (+ edit alias). Default: keep. */
  imageGen?: boolean;
  /** When false, drop `/imagine-video`. Default: keep. */
  videoGen?: boolean;
}

/** Drop hidden commands from an advertised `available_commands_update` list. */
export function filterAdvertisedCommands<T extends { name: string }>(
  commands: T[],
  opts?: FilterAdvertisedOptions,
): T[] {
  return commands.filter((c) => {
    if (HIDDEN_SLASH_COMMANDS.has(c.name)) return false;
    if (opts?.imageGen === false && IMAGE_GEN_SLASH_COMMANDS.has(c.name)) return false;
    if (opts?.videoGen === false && VIDEO_GEN_SLASH_COMMANDS.has(c.name)) return false;
    return true;
  });
}

/**
 * Merge extension-owned slash commands into the filtered advertised list.
 * Idempotent: if the CLI already advertises a name (future builds), keep the
 * CLI entry. New entries are inserted in name order so `/` popover stay sorted.
 */
export function withExtensionSlashCommands<T extends { name: string; description?: string }>(
  commands: T[],
): Array<T | SlashCmd> {
  const out: Array<T | SlashCmd> = commands.slice();
  for (const extra of EXTENSION_SLASH_COMMANDS) {
    if (out.some((c) => c.name === extra.name)) continue;
    const i = out.findIndex((c) => c.name.localeCompare(extra.name) > 0);
    if (i === -1) out.push(extra);
    else out.splice(i, 0, extra);
  }
  return out;
}

/** True when a leading slash command is a media-gen tool that's currently disabled. */
export function isDisabledMediaSlash(
  command: string | null | undefined,
  flags: { image: boolean; video: boolean },
): boolean {
  if (!command) return false;
  if (!flags.image && IMAGE_GEN_SLASH_COMMANDS.has(command)) return true;
  if (!flags.video && VIDEO_GEN_SLASH_COMMANDS.has(command)) return true;
  return false;
}

/**
 * Given the current composer text and cursor position, return the slash-command query
 * (the chars after `/` on the line that the caret is in) or `null` if no popover is active.
 *
 * The popover activates only when `/` is at the start of the line or after a newline.
 */
export function getSlashQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|\n)\/(\S*)$/);
  return m ? m[1] : null;
}

export function filterCommands(commands: SlashCmd[], query: string): SlashCmd[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/** Replace the partial `/q` token with `/<name> ` and return the new text + caret. */
export function applySlashPick(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const newBefore = before.replace(/(?:^|\n)\/(\S*)$/, (m) =>
    m.startsWith("\n") ? `\n/${name} ` : `/${name} `,
  );
  return { text: newBefore + after, caret: newBefore.length };
}

/**
 * The slash command a typed message dispatches, or `null` for ordinary prose.
 *
 * The CLI only recognizes a slash command when it sits at position 0 of the
 * prompt's text block — editor-injected context in front of it silently turns
 * `/compact` into a normal LLM turn (verified against grok 0.2.87 in
 * research/compact-probe.cjs). The caller uses a match to move that context
 * BEHIND the command text instead (see buildPrompt), so this must never match
 * prose: the token boundary rejects Unix paths (`/tmp/foo` — `tmp` is followed
 * by `/`, not whitespace/end), and a known-commands check rejects things shaped
 * like commands that grok never advertised. An empty `commandNames` means the
 * `available_commands_update` hasn't arrived yet — fall back to shape alone,
 * since a wrongly-trailing envelope (broken dispatch) costs far more than a
 * wrongly-leading one (grok just reads the context first).
 */
export function matchSlashCommand(text: string, commandNames: string[]): string | null {
  const m = text.match(/^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/);
  if (!m) return null;
  if (commandNames.length === 0) return m[1];
  return commandNames.includes(m[1]) ? m[1] : null;
}
