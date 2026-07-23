/**
 * Minimal reader for grok's `config.toml` — just enough for the extension's
 * honesty surfaces (#31 always-approve, combine-queued, image/video gen flags).
 * No TOML dependency: a section-aware line scan for the keys we care about.
 *
 * grok writes `permission_mode = "always-approve"` when the user picks
 * "Always Approve" via Shift+Tab or runs `/always-approve` in the TUI, which
 * silently makes *every* grok session (CLI + this extension) auto-approve tool
 * actions server-side. The extension can't see that over ACP (the CLI still
 * reports the ordinary `default`/agent mode), so it reads the file directly to
 * keep the mode button honest.
 */

/** True when a `permission_mode` value means "auto-approve everything". grok
 *  writes the hyphenated spelling; the underscore variant is accepted too. */
export function isAlwaysApprovePermission(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase().replace(/_/g, "-") === "always-approve";
}

/**
 * Read a string key from a named table of a config.toml string, or `undefined`
 * when the table/key is absent. Comments (`#…`) and surrounding quotes are
 * stripped; only the named table is consulted so a same-named key under another
 * table can't be misread.
 */
export function readTomlTableString(
  toml: string,
  tableName: string,
  key: string,
): string | undefined {
  let inTable = false;
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`);
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (table) {
      inTable = table[1].trim() === tableName;
      continue;
    }
    if (!inTable) continue;
    const kv = line.match(keyRe);
    if (kv) return kv[1].trim().replace(/^["']|["']$/g, "").trim();
  }
  return undefined;
}

/**
 * Read a boolean key from a named table. Accepts `true`/`false` (case-
 * insensitive) and the common `1`/`0` spellings; undefined when absent or
 * unparseable (callers apply their own defaults).
 */
export function readTomlTableBool(
  toml: string,
  tableName: string,
  key: string,
): boolean | undefined {
  const raw = readTomlTableString(toml, tableName, key);
  if (raw == null) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/**
 * Read `permission_mode` from the `[ui]` table of a config.toml string, or
 * `undefined` when the table/key is absent.
 */
export function readUiPermissionMode(toml: string): string | undefined {
  return readTomlTableString(toml, "ui", "permission_mode");
}

/**
 * The effective always-approve verdict from a project + global config pair.
 * Project `.grok/config.toml` overrides global `~/.grok/config.toml` (grok
 * merges project over global); a key absent from project falls back to global.
 * Either string may be `undefined` (file missing / unreadable).
 */
export function configForcesAlwaysApprove(input: {
  project?: string;
  global?: string;
}): boolean {
  const projectMode = input.project != null ? readUiPermissionMode(input.project) : undefined;
  const effective =
    projectMode ?? (input.global != null ? readUiPermissionMode(input.global) : undefined);
  return isAlwaysApprovePermission(effective);
}

/**
 * Whether the CLI should combine queued follow-ups into a single turn
 * (`[ui] combine_queued_prompts`, 0.2.109+). Default **true** (matches the TUI
 * default: host-owned queue appends with a blank-line separator and flushes as
 * one prompt). When false, each queued message is its own turn.
 *
 * Project config overrides global; absent key → true.
 */
export function configCombineQueuedPrompts(input: {
  project?: string;
  global?: string;
}): boolean {
  const from = (toml: string | undefined) =>
    toml != null ? readTomlTableBool(toml, "ui", "combine_queued_prompts") : undefined;
  return from(input.project) ?? from(input.global) ?? true;
}

/**
 * Whether a feature flag env value enables the feature. Matches grok's usual
 * `1`/`true`/`yes` enable and `0`/`false`/`no` disable spellings (case-
 * insensitive). Undefined when unset/unrecognized so callers can fall through
 * to config/default.
 */
export function parseFeatureEnv(value: string | undefined): boolean | undefined {
  if (value == null || value === "") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

export interface MediaGenFlags {
  /** Image generation (`/imagine`, image_gen / image_edit). Default true. */
  image: boolean;
  /** Video generation (`/imagine-video`, video_gen). Default true. */
  video: boolean;
}

/**
 * Effective image/video generation enable flags (0.2.111).
 *
 * Precedence (highest first), matching the CLI's feature knobs:
 *   1. Env `GROK_IMAGE_GEN` / `GROK_VIDEO_GEN` (and `GROK_IMAGE_EDIT` as an
 *      image-side alias when image_gen itself is unset)
 *   2. Project `.grok/config.toml` `[features] image_gen` / `video_gen`
 *   3. Global `~/.grok/config.toml` same keys
 *   4. Default **true** (tools available)
 *
 * When disabled, the extension hides the matching slash commands from
 * autocomplete and soft-blocks a typed send.
 */
export function configMediaGenEnabled(input: {
  project?: string;
  global?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): MediaGenFlags {
  const env = input.env ?? {};
  const fromToml = (toml: string | undefined, key: string) =>
    toml != null ? readTomlTableBool(toml, "features", key) : undefined;

  const imageEnv =
    parseFeatureEnv(env.GROK_IMAGE_GEN) ?? parseFeatureEnv(env.GROK_IMAGE_EDIT);
  const videoEnv = parseFeatureEnv(env.GROK_VIDEO_GEN);

  const image =
    imageEnv ??
    fromToml(input.project, "image_gen") ??
    fromToml(input.global, "image_gen") ??
    true;
  const video =
    videoEnv ??
    fromToml(input.project, "video_gen") ??
    fromToml(input.global, "video_gen") ??
    true;
  return { image, video };
}

/**
 * Best-effort auth method for the session UI when `/session-info` hasn't been
 * scraped yet. Pure: callers pass whether `~/.grok/auth.json` exists and whether
 * an `XAI_API_KEY` (or model-config key) is in play. Prefer
 * `parseSessionInfoAuth` once a real session-info reply is available.
 */
export function detectAuthMethod(input: {
  authJsonExists?: boolean;
  xaiApiKey?: boolean;
}): { method: "oauth" | "api-key" | "unknown"; label: string; manageUrl?: string } {
  if (input.authJsonExists) {
    return {
      method: "oauth",
      label: "OAuth",
      manageUrl: "https://grok.com/?_s=billing",
    };
  }
  if (input.xaiApiKey) {
    return {
      method: "api-key",
      label: "API key",
      manageUrl: "https://console.x.ai",
    };
  }
  return { method: "unknown", label: "Unknown" };
}
