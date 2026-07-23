import { describe, it, expect } from "vitest";
import {
  DOCTOR_CLI_ARGS,
  DOCTOR_SLASH_ALIASES,
  DOCTOR_SLASH_NAME,
  formatDoctorReport,
  formatDoctorSummary,
  isDoctorSlash,
  parseDoctorJson,
  parseDoctorSlash,
  type DoctorReport,
} from "../src/doctor";

/** Minimal fixture matching grok 0.2.111 `grok doctor --json` (healthy Windows). */
const SAMPLE_JSON = `{
  "schemaVersion": "1",
  "facts": {
    "terminal": {
      "name": "vs_code",
      "xtversion": { "status": "unavailable", "value": null }
    },
    "multiplexer": { "kind": "undetected", "byobu": null },
    "ssh": false,
    "color": {
      "level": { "status": "available", "value": "truecolor" },
      "availableThemes": ["groknight", "grokday", "tokyonight"],
      "totalThemes": 5
    },
    "keyboard": null,
    "newline": { "kind": "xterm_js", "terminalName": "vs_code" },
    "clipboard": {
      "nativeRoute": true,
      "nativeTool": "arboard",
      "nativePreflight": "local_available",
      "tmuxRoute": false,
      "osc52Route": false,
      "osc52Capability": "supported",
      "wrapSink": false,
      "delivery": "confirmed"
    },
    "voice": {
      "status": "available",
      "name": "Microphone (Test)",
      "detail": "48000 Hz, 2 ch, F32"
    }
  },
  "findings": [],
  "probeNotes": [
    { "probe": "runtime.fullscreen-active", "status": "unavailable", "message": null }
  ],
  "counts": { "issues": 0, "recommendations": 0, "probeNotes": 1 }
}`;

describe("parseDoctorSlash / isDoctorSlash", () => {
  it("matches /doctor and permanent aliases", () => {
    expect(isDoctorSlash("/doctor")).toBe(true);
    expect(isDoctorSlash("  /doctor  ")).toBe(true);
    expect(isDoctorSlash("/terminal-setup")).toBe(true);
    expect(isDoctorSlash("/terminal-check")).toBe(true);
    expect(isDoctorSlash("/terminal-info")).toBe(true);
    expect(parseDoctorSlash("/doctor")).toEqual({});
  });

  it("is case-insensitive on the slash name", () => {
    expect(isDoctorSlash("/Doctor")).toBe(true);
    expect(isDoctorSlash("/TERMINAL-SETUP")).toBe(true);
  });

  it("matches with trailing junk (intercept rather than send as prose)", () => {
    expect(isDoctorSlash("/doctor please")).toBe(true);
  });

  it("rejects non-doctor text", () => {
    expect(isDoctorSlash("doctor no slash")).toBe(false);
    expect(isDoctorSlash("/doctors")).toBe(false);
    expect(isDoctorSlash("/compact")).toBe(false);
    expect(isDoctorSlash("run /doctor later")).toBe(false);
    expect(parseDoctorSlash("")).toBeNull();
  });

  it("exports stable slash constants", () => {
    expect(DOCTOR_SLASH_NAME).toBe("doctor");
    expect(DOCTOR_SLASH_ALIASES).toContain("doctor");
    expect(DOCTOR_SLASH_ALIASES).toContain("terminal-setup");
    expect(DOCTOR_CLI_ARGS).toEqual(["doctor", "--json"]);
  });
});

describe("parseDoctorJson", () => {
  it("parses a real 0.2.111-shaped report", () => {
    const r = parseDoctorJson(SAMPLE_JSON);
    expect(r).not.toBeNull();
    expect(r!.schemaVersion).toBe("1");
    expect(r!.facts?.terminal?.name).toBe("vs_code");
    expect(r!.counts?.issues).toBe(0);
    expect(r!.probeNotes).toHaveLength(1);
  });

  it("tolerates leading noise before the JSON object", () => {
    const r = parseDoctorJson("warn: something\n" + SAMPLE_JSON + "\n");
    expect(r?.facts?.terminal?.name).toBe("vs_code");
  });

  it("returns null for empty / non-report JSON", () => {
    expect(parseDoctorJson("")).toBeNull();
    expect(parseDoctorJson("not json")).toBeNull();
    expect(parseDoctorJson('{"foo":1}')).toBeNull();
    expect(parseDoctorJson("[]")).toBeNull();
  });
});

describe("formatDoctorReport / formatDoctorSummary", () => {
  const report = parseDoctorJson(SAMPLE_JSON)!;

  it("formats a readable multi-section report", () => {
    const text = formatDoctorReport(report);
    expect(text).toMatch(/^Grok Doctor/m);
    expect(text).toMatch(/Terminal/);
    expect(text).toMatch(/VS Code/);
    expect(text).toMatch(/truecolor/);
    expect(text).toMatch(/Clipboard/);
    expect(text).toMatch(/confirmed/);
    expect(text).toMatch(/Voice/);
    expect(text).toMatch(/Microphone \(Test\)/);
    expect(text).toMatch(/Probe notes/);
    expect(text).toMatch(/0 issues, 0 recommendations/);
  });

  it("includes findings when present", () => {
    const withFindings: DoctorReport = {
      ...report,
      findings: [
        {
          id: "terminal.ssh-wrap",
          severity: "recommendation",
          title: "Use grok wrap over SSH",
          message: "Clipboard may not reach the local host.",
        },
      ],
      counts: { issues: 0, recommendations: 1, probeNotes: 0 },
    };
    const text = formatDoctorReport(withFindings);
    expect(text).toMatch(/Findings/);
    expect(text).toMatch(/ssh-wrap|Use grok wrap/);
    expect(text).toMatch(/1 recommendation/);
  });

  it("summary is a compact one-liner", () => {
    const s = formatDoctorSummary(report);
    expect(s).toMatch(/0 issues/);
    expect(s).toMatch(/0 recommendations/);
    expect(s).toMatch(/VS Code/);
    expect(s).toMatch(/truecolor/);
  });

  it("rawText fallback when no structured facts", () => {
    const r: DoctorReport = { rawText: "Grok Doctor\n  · all good\n" };
    expect(formatDoctorReport(r)).toMatch(/all good/);
    expect(formatDoctorSummary(r)).toMatch(/Grok Doctor/);
  });
});
