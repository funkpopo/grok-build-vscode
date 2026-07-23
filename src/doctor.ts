/**
 * Pure helpers for Grok Build CLI `/doctor` diagnostics (P3-20 partial).
 *
 * The TUI slash is a **pager builtin** — it is **not** advertised over ACP
 * `available_commands_update` (probe-confirmed 0.2.111). Standalone:
 *
 *   grok doctor
 *   grok doctor --json
 *
 * Schema (0.2.111): `{ schemaVersion:"1", facts, findings, probeNotes, counts }`.
 * The extension runs the CLI subprocess, formats the report for the Output
 * channel, and posts a compact summary card to the webview. Session
 * export/share is out of scope for this surface.
 *
 * Slash aliases (same as the CLI): `/doctor`, `/terminal-setup`,
 * `/terminal-check`, `/terminal-info`.
 */

/** Primary slash name shown in the `/` autocomplete popover. */
export const DOCTOR_SLASH_NAME = "doctor";

/** All slash tokens that run the same diagnostics (CLI permanent aliases). */
export const DOCTOR_SLASH_ALIASES: readonly string[] = [
  "doctor",
  "terminal-setup",
  "terminal-check",
  "terminal-info",
];

/**
 * True when composer text is a leading doctor slash (any alias), with optional
 * trailing args ignored (the CLI accepts bare `/doctor` only — we still match
 * `/doctor anything` so a mistype is intercepted rather than sent as prose).
 */
export function isDoctorSlash(text: string): boolean {
  return parseDoctorSlash(text) != null;
}

/**
 * Parse a leading doctor slash. Returns `{}` when matched (no args today),
 * `null` when the text is not a doctor command.
 */
export function parseDoctorSlash(text: string): Record<string, never> | null {
  const t = String(text ?? "").trim();
  const m = t.match(/^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!DOCTOR_SLASH_ALIASES.includes(name)) return null;
  return {};
}

// ---------- JSON report shape (schemaVersion "1", grok 0.2.109+) ----------

export interface DoctorProbeValue {
  status?: string;
  value?: unknown;
}

export interface DoctorFacts {
  terminal?: {
    name?: string;
    xtversion?: DoctorProbeValue | null;
  };
  multiplexer?: {
    kind?: string;
    byobu?: unknown;
  };
  ssh?: boolean;
  color?: {
    level?: DoctorProbeValue | string | null;
    availableThemes?: string[];
    totalThemes?: number;
  };
  keyboard?: unknown;
  newline?: {
    kind?: string;
    terminalName?: string;
  };
  clipboard?: Record<string, unknown>;
  voice?: {
    status?: string;
    name?: string;
    detail?: string;
  } | null;
  [key: string]: unknown;
}

export interface DoctorFinding {
  /** Canonical id when present (e.g. `terminal.ssh-wrap`). */
  id?: string;
  severity?: string;
  title?: string;
  message?: string;
  summary?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface DoctorProbeNote {
  probe?: string;
  status?: string;
  message?: string | null;
  [key: string]: unknown;
}

export interface DoctorCounts {
  issues?: number;
  recommendations?: number;
  probeNotes?: number;
}

export interface DoctorReport {
  schemaVersion?: string;
  facts?: DoctorFacts;
  findings?: DoctorFinding[];
  probeNotes?: DoctorProbeNote[];
  counts?: DoctorCounts;
  /** Present when the CLI emitted plain text only (no --json). */
  rawText?: string;
}

/** Parse `grok doctor --json` stdout. Returns null when the payload is not a report object. */
export function parseDoctorJson(text: string): DoctorReport | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  // Tolerate leading/trailing noise (warnings on stderr sometimes leak to stdout
  // when shells merge streams); take the outermost `{…}` slice.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  // Require at least one known top-level key so a random JSON object isn't treated as a report.
  if (!("facts" in o) && !("findings" in o) && !("counts" in o) && !("schemaVersion" in o)) {
    return null;
  }
  return parsed as DoctorReport;
}

function probeDisplay(v: DoctorProbeValue | string | null | undefined): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (v.value != null && v.value !== "") return String(v.value);
    if (v.status) return String(v.status);
  }
  return "—";
}

function terminalDisplayName(name: string | undefined): string {
  if (!name) return "—";
  // CLI human output uses friendly labels; keep the raw id when unknown.
  const map: Record<string, string> = {
    windows_terminal: "Windows Terminal",
    vs_code: "VS Code",
    cursor: "Cursor",
    windsurf: "Windsurf",
    zed: "Zed",
    iterm2: "iTerm2",
    ghostty: "Ghostty",
    kitty: "Kitty",
    wezterm: "WezTerm",
    alacritty: "Alacritty",
    apple_terminal: "Apple Terminal",
    warp: "Warp",
    foot: "foot",
    vte: "VTE",
    jetbrains: "JetBrains",
    grok_desktop: "Grok Desktop",
    rio: "Rio",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

function themesDisplay(color: DoctorFacts["color"]): string {
  if (!color) return "—";
  const total = typeof color.totalThemes === "number" ? color.totalThemes : undefined;
  const avail = Array.isArray(color.availableThemes) ? color.availableThemes.length : undefined;
  if (total != null && avail != null) {
    if (avail >= total) return "all";
    return `${avail}/${total}`;
  }
  if (avail != null) return String(avail);
  return "—";
}

function clipboardStatus(cb: Record<string, unknown> | undefined): string {
  if (!cb) return "—";
  if (typeof cb.delivery === "string" && cb.delivery) return cb.delivery;
  if (typeof cb.nativePreflight === "string" && cb.nativePreflight) return cb.nativePreflight;
  return "—";
}

function yn(v: unknown): string {
  if (v === true) return "on";
  if (v === false) return "off";
  return "—";
}

function findingLine(f: DoctorFinding): string {
  const sev = (f.severity || f.id || "finding").toString();
  const title = (f.title || f.summary || f.message || f.detail || f.id || "").toString().trim();
  const body = [f.message, f.detail].filter((x) => typeof x === "string" && x && x !== title).join(" — ");
  if (title && body) return `  · ${sev}  ${title} — ${body}`;
  if (title) return `  · ${sev}  ${title}`;
  return `  · ${sev}`;
}

/**
 * Format a doctor report as plain text for the Output channel (close to the
 * CLI's human layout, without ANSI).
 */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.rawText && !report.facts && !(report.findings && report.findings.length)) {
    return report.rawText.trimEnd() + "\n";
  }

  const lines: string[] = ["Grok Doctor", ""];
  const facts = report.facts || {};
  const term = facts.terminal;
  const color = facts.color;
  const mux = facts.multiplexer;
  const nl = facts.newline;
  const cb = facts.clipboard as Record<string, unknown> | undefined;
  const voice = facts.voice;

  lines.push("Terminal");
  lines.push(`  · terminal                     ${terminalDisplayName(term?.name)}`);
  lines.push(`  · xtversion                    ${probeDisplay(term?.xtversion)}`);
  const muxKind = mux?.kind && mux.kind !== "undetected" ? String(mux.kind) : "None detected";
  lines.push(`  · multiplexer                  ${muxKind}`);
  lines.push(`  · ssh                          ${facts.ssh ? "yes" : "no"}`);
  lines.push(`  · color                        ${probeDisplay(color?.level)}`);
  lines.push(`  · themes                       ${themesDisplay(color)}`);
  if (nl?.kind) {
    const nlExtra = nl.terminalName ? ` (${nl.terminalName})` : "";
    lines.push(`  · newline                      ${nl.kind}${nlExtra}`);
  } else {
    lines.push("  · newline                      —");
  }

  lines.push("");
  lines.push("Clipboard");
  if (cb) {
    const nativeTool = typeof cb.nativeTool === "string" ? ` (${cb.nativeTool})` : "";
    lines.push(`  · native                       ${cb.nativeRoute ? `local${nativeTool}` : "off"}`);
    lines.push(`  · tmux                         ${yn(cb.tmuxRoute)}`);
    lines.push(`  · osc 52                       ${yn(cb.osc52Route)}`);
    lines.push(`  · wrap                         ${yn(cb.wrapSink)}`);
    lines.push(`  · status                       ${clipboardStatus(cb)}`);
  } else {
    lines.push("  · (no clipboard facts)");
  }

  if (voice && typeof voice === "object") {
    lines.push("");
    lines.push("Voice");
    const vname = voice.name || voice.status || "—";
    const vdetail = voice.detail ? ` (${voice.detail})` : "";
    lines.push(`  · microphone                   ${vname}${vdetail}`);
  }

  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (findings.length) {
    lines.push("");
    lines.push("Findings");
    for (const f of findings) lines.push(findingLine(f));
  }

  const notes = Array.isArray(report.probeNotes) ? report.probeNotes : [];
  if (notes.length) {
    lines.push("");
    lines.push("Probe notes");
    for (const n of notes) {
      const probe = n.probe || "probe";
      const status = n.status || "—";
      const msg = n.message ? `  ${n.message}` : "";
      lines.push(`  · ${probe.padEnd(28)} ${status}${msg}`);
    }
  }

  lines.push("");
  lines.push("Live TUI evidence");
  lines.push("  Run /doctor inside the standalone Grok TUI for runtime-only probes.");
  lines.push("");

  const issues = report.counts?.issues ?? findings.filter((f) => /issue/i.test(String(f.severity || ""))).length;
  const recs =
    report.counts?.recommendations ??
    findings.filter((f) => /recommend/i.test(String(f.severity || ""))).length;
  lines.push(`${issues} issue${issues === 1 ? "" : "s"}, ${recs} recommendation${recs === 1 ? "" : "s"}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * One-line (or short multi-line) summary for the chat card.
 * Example: `0 issues · 0 recommendations · VS Code · color truecolor`
 */
export function formatDoctorSummary(report: DoctorReport): string {
  if (report.rawText && !report.facts) {
    const first = report.rawText.trim().split(/\r?\n/).find((l) => l.trim()) || "Doctor report";
    return first.slice(0, 120);
  }
  const facts = report.facts || {};
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const issues = report.counts?.issues ?? findings.filter((f) => /issue/i.test(String(f.severity || ""))).length;
  const recs =
    report.counts?.recommendations ??
    findings.filter((f) => /recommend/i.test(String(f.severity || ""))).length;
  const parts = [
    `${issues} issue${issues === 1 ? "" : "s"}`,
    `${recs} recommendation${recs === 1 ? "" : "s"}`,
  ];
  const term = terminalDisplayName(facts.terminal?.name);
  if (term && term !== "—") parts.push(term);
  const color = probeDisplay(facts.color?.level);
  if (color && color !== "—") parts.push(`color ${color}`);
  const clip = clipboardStatus(facts.clipboard as Record<string, unknown> | undefined);
  if (clip && clip !== "—") parts.push(`clipboard ${clip}`);
  return parts.join(" · ");
}

/** Args for the standalone doctor subprocess (always request JSON). */
export const DOCTOR_CLI_ARGS: readonly string[] = ["doctor", "--json"];
