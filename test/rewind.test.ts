import { describe, it, expect } from "vitest";
import {
  parseRewindPoint,
  parseRewindPoints,
  parseRewindExecute,
  formatRewindPointLabel,
  formatRewindPointDetail,
  selectableRewindPoints,
  userFacingRewindPoints,
  resolveUserBubbleRewind,
  previousRewindPoint,
  isHiddenRewindPoint,
  rewindConfirmMessage,
  rewindComposerText,
  parseRewindPointsJsonl,
  parseRewindDiskPoint,
  computeRewindRestoreActions,
  resolveRewindWorkspacePath,
  summarizeRewindRestoreActions,
  truncateUpdatesJsonl,
  truncateChatHistoryJsonl,
  truncateRewindPointsJsonl,
  REWIND_MODES,
} from "../src/rewind";

describe("parseRewindPoints", () => {
  const row = {
    prompt_index: 0,
    created_at: "2026-07-23T03:00:00Z",
    num_file_snapshots: 2,
    has_file_changes: true,
    prompt_preview: "Fix the auth bug",
  };

  it("parses bare { rewind_points }", () => {
    const pts = parseRewindPoints({ rewind_points: [row] });
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({
      promptIndex: 0,
      createdAt: "2026-07-23T03:00:00Z",
      numFileSnapshots: 2,
      hasFileChanges: true,
      promptPreview: "Fix the auth bug",
    });
  });

  it("unwraps a double-wrapped result", () => {
    expect(parseRewindPoints({ result: { rewind_points: [row] } })).toHaveLength(1);
  });

  it("parses a bare array", () => {
    expect(parseRewindPoints([row])).toHaveLength(1);
  });

  it("returns [] for empty / garbage", () => {
    expect(parseRewindPoints(null)).toEqual([]);
    expect(parseRewindPoints({})).toEqual([]);
    expect(parseRewindPoints({ rewind_points: [] })).toEqual([]);
  });

  it("skips rows without a valid prompt_index", () => {
    expect(parseRewindPoint({ prompt_preview: "x" })).toBeNull();
    expect(parseRewindPoint({ prompt_index: -1 })).toBeNull();
  });

  it("accepts camelCase fallbacks", () => {
    const p = parseRewindPoint({
      promptIndex: 3,
      createdAt: "t",
      numFileSnapshots: 0,
      hasFileChanges: false,
      promptPreview: "hi",
    });
    expect(p?.promptIndex).toBe(3);
    expect(p?.promptPreview).toBe("hi");
  });
});

describe("parseRewindExecute", () => {
  it("parses a successful execute result", () => {
    const r = parseRewindExecute({
      success: true,
      target_prompt_index: 1,
      mode: "all",
      reverted_files: ["a.ts"],
      clean_files: [],
      conflicts: [],
      prompt_text: "Say B",
      error: null,
    });
    expect(r).toEqual({
      success: true,
      targetPromptIndex: 1,
      mode: "all",
      revertedFiles: ["a.ts"],
      cleanFiles: [],
      conflicts: [],
      promptText: "Say B",
      error: null,
    });
  });

  it("parses success:false with an error string", () => {
    const r = parseRewindExecute({
      success: false,
      target_prompt_index: 0,
      mode: "all",
      reverted_files: [],
      clean_files: [],
      conflicts: [],
      prompt_text: null,
      error: "Cannot rewind to prompt #0 — current prompt index is 0",
    });
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/Cannot rewind/);
  });

  it("returns null without a boolean success", () => {
    expect(parseRewindExecute({ target_prompt_index: 1 })).toBeNull();
    expect(parseRewindExecute(null)).toBeNull();
  });

  it("unwraps double-wrapped payloads", () => {
    const r = parseRewindExecute({
      result: {
        success: true,
        target_prompt_index: 0,
        mode: "conversation_only",
        reverted_files: [],
        clean_files: [],
        conflicts: [],
        prompt_text: "x",
        error: null,
      },
    });
    expect(r?.mode).toBe("conversation_only");
  });
});

describe("selectableRewindPoints / labels", () => {
  const pts = [
    { promptIndex: 0, createdAt: "2026-07-23T01:00:00Z", numFileSnapshots: 0, hasFileChanges: false, promptPreview: "alpha" },
    { promptIndex: 1, createdAt: "2026-07-23T01:01:00Z", numFileSnapshots: 1, hasFileChanges: true, promptPreview: "beta" },
    { promptIndex: 2, createdAt: "2026-07-23T01:02:00Z", numFileSnapshots: 0, hasFileChanges: false, promptPreview: "gamma" },
  ];

  it("includes every point including the tip (force:true allows tip execute)", () => {
    const sel = selectableRewindPoints(pts);
    expect(sel.map((p) => p.promptIndex)).toEqual([0, 1, 2]);
  });

  it("returns the sole point when only one exists; [] for empty", () => {
    expect(selectableRewindPoints([pts[0]]).map((p) => p.promptIndex)).toEqual([0]);
    expect(selectableRewindPoints([])).toEqual([]);
  });

  it("formats a scannable label with optional file badge", () => {
    expect(formatRewindPointLabel(pts[0])).toBe("#0  alpha");
    expect(formatRewindPointLabel(pts[1])).toMatch(/^#1  beta · 1 file$/);
  });

  it("formats a locale timestamp detail", () => {
    const d = formatRewindPointDetail(pts[0]);
    expect(d).toBeTruthy();
    expect(formatRewindPointDetail({ ...pts[0], createdAt: "" })).toBeUndefined();
  });

  it("builds a confirm message for the target bubble", () => {
    const msg = rewindConfirmMessage(pts[1], "all");
    expect(msg).toMatch(/Rewind from this message/i);
    expect(msg).toContain("beta");
    expect(msg).toMatch(/discarded|composer/i);
  });
});

describe("REWIND_MODES", () => {
  it("lists the four wire modes", () => {
    expect(REWIND_MODES).toEqual(["all", "conversation_only", "code_only", "files_only"]);
  });
});

describe("userFacingRewindPoints / resolveUserBubbleRewind", () => {
  const primer = {
    promptIndex: 0,
    createdAt: "t0",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "[grok-build-vscode primer v4]\n\n## HIDDEN PRIMER",
  };
  const u0 = {
    promptIndex: 1,
    createdAt: "t1",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "first user message",
  };
  const u1 = {
    promptIndex: 2,
    createdAt: "t2",
    numFileSnapshots: 1,
    hasFileChanges: true,
    promptPreview: "second user message",
  };
  const u2 = {
    promptIndex: 3,
    createdAt: "t3",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "third user message",
  };
  const all = [primer, u0, u1, u2];

  it("hides the primer and system-reminder points", () => {
    expect(isHiddenRewindPoint(primer)).toBe(true);
    expect(isHiddenRewindPoint(u0)).toBe(false);
    expect(
      isHiddenRewindPoint({
        ...u0,
        promptPreview: "<system-reminder>bg task</system-reminder>",
      }),
    ).toBe(true);
  });

  it("maps bubble index past the primer to the wire prompt_index", () => {
    const facing = userFacingRewindPoints(all);
    expect(facing.map((p) => p.promptIndex)).toEqual([1, 2, 3]);
    const r0 = resolveUserBubbleRewind(all, 0);
    expect(r0?.execute.promptIndex).toBe(1);
    expect(r0?.bubble.promptIndex).toBe(1);
    expect(r0?.undoingTip).toBe(false);
    expect(resolveUserBubbleRewind(all, 1)?.execute.promptIndex).toBe(2);
  });

  it("maps the tip bubble to its own wire index; null for out-of-range", () => {
    const tip = resolveUserBubbleRewind(all, 2);
    expect(tip?.execute.promptIndex).toBe(3);
    expect(tip?.bubble.promptIndex).toBe(3);
    expect(tip?.undoingTip).toBe(false);
    expect(resolveUserBubbleRewind(all, 99)).toBeNull();
    expect(resolveUserBubbleRewind(all, -1)).toBeNull();
  });

  it("sole first user message executes its own wire index (not the primer)", () => {
    const sole = [primer, u0];
    const r = resolveUserBubbleRewind(sole, 0);
    expect(r?.undoingTip).toBe(false);
    expect(r?.bubble.promptIndex).toBe(1);
    expect(r?.execute.promptIndex).toBe(1);
    expect(previousRewindPoint(sole, 1)?.promptIndex).toBe(0);
  });

  it("works when there is no primer — including sole tip and multi tip", () => {
    const bare = [u0, u1].map((p, i) => ({ ...p, promptIndex: i }));
    expect(resolveUserBubbleRewind(bare, 0)?.execute.promptIndex).toBe(0);
    expect(resolveUserBubbleRewind(bare, 1)?.execute.promptIndex).toBe(1);
    // Sole message at index 0 is a valid tip target with force:true.
    const sole = resolveUserBubbleRewind([{ ...u0, promptIndex: 0 }], 0);
    expect(sole?.execute.promptIndex).toBe(0);
    expect(sole?.undoingTip).toBe(false);
  });

  it("confirm copy distinguishes undo-tip vs rewind-from", () => {
    const undo = rewindConfirmMessage(u0, "all", { undoingTip: true });
    expect(undo).toMatch(/Discard this turn/i);
    expect(undo).toMatch(/composer/i);
    const to = rewindConfirmMessage(u0, "all");
    expect(to).toMatch(/Rewind from this message/i);
    expect(to).toMatch(/composer/i);
  });
});

describe("rewindComposerText", () => {
  it("prefers full bubble text over wire prompt_text", () => {
    expect(
      rewindComposerText({
        bubbleText: " full bubble ",
        promptText: "wire",
        promptPreview: "prev",
      }),
    ).toBe("full bubble");
  });

  it("uses prompt_text when not undoing tip and no bubble text", () => {
    expect(
      rewindComposerText({
        promptText: "MSG_B only. No tools.",
        promptPreview: "MSG_B…",
      }),
    ).toBe("MSG_B only. No tools.");
  });

  it("ignores primer prompt_text when undoing tip (sole first message)", () => {
    const primer = "[grok-build-vscode primer v5]\n\n## HIDDEN PRIMER\nok";
    expect(
      rewindComposerText({
        promptText: primer,
        promptPreview: "ONLY_USER_MSG. No tools.",
        undoingTip: true,
      }),
    ).toBe("ONLY_USER_MSG. No tools.");
  });
});

describe("disk snapshot restore plan (CLI delete backstop)", () => {
  const jsonl = [
    JSON.stringify({
      prompt_index: 0,
      file_snapshots: {},
      after_snapshots: {},
    }),
    JSON.stringify({
      prompt_index: 1,
      file_snapshots: {
        "created.txt": { path: "created.txt", content: null, captured_at: "t" },
        "seed.txt": { path: "seed.txt", content: "v1\n", captured_at: "t" },
      },
      after_snapshots: {
        "created.txt": { path: "created.txt", content: "NEWFILE\n", captured_at: "t" },
        "seed.txt": { path: "seed.txt", content: "V2\n", captured_at: "t" },
      },
    }),
    JSON.stringify({
      prompt_index: 2,
      file_snapshots: {
        "seed.txt": { path: "seed.txt", content: "V2\n", captured_at: "t" },
        "other.ts": { path: "other.ts", content: "a", captured_at: "t" },
      },
      after_snapshots: {
        "seed.txt": { path: "seed.txt", content: "V3\n", captured_at: "t" },
        "other.ts": { path: "other.ts", content: "b", captured_at: "t" },
      },
    }),
  ].join("\n");

  it("parses rewind_points.jsonl including null content", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    expect(pts).toHaveLength(3);
    expect(pts[1].fileSnapshots["created.txt"].content).toBeNull();
    expect(pts[1].fileSnapshots["seed.txt"].content).toBe("v1\n");
    expect(pts[1].afterSnapshots["created.txt"].content).toBe("NEWFILE\n");
  });

  it("execute(0) discards all turns' file changes (pre-turn-0 state)", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    const actions = computeRewindRestoreActions(pts, 0);
    // point #0 empty; #1 first touch: created→delete, seed→v1; #2 other.ts
    expect(actions).toEqual([
      { kind: "delete", path: "created.txt" },
      { kind: "write", path: "other.ts", content: "a" },
      { kind: "write", path: "seed.txt", content: "v1\n" },
    ]);
    const sum = summarizeRewindRestoreActions(actions);
    expect(sum.deleted).toBe(1);
    expect(sum.written).toBe(2);
  });

  it("execute(1) discards turn 1 and later (CLI exclusive)", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    const actions = computeRewindRestoreActions(pts, 1);
    // Turn 1's pre-snaps win: created→delete, seed→v1; turn 2 adds other.ts
    expect(actions).toEqual([
      { kind: "delete", path: "created.txt" },
      { kind: "write", path: "other.ts", content: "a" },
      { kind: "write", path: "seed.txt", content: "v1\n" },
    ]);
  });

  it("execute(2) undoes only the tip turn's file changes", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    expect(computeRewindRestoreActions(pts, 2)).toEqual([
      { kind: "write", path: "other.ts", content: "a" },
      { kind: "write", path: "seed.txt", content: "V2\n" },
    ]);
    // Beyond last point — no snapshots in range
    expect(computeRewindRestoreActions(pts, 99)).toEqual([]);
  });

  it("treats missing content as null (did not exist)", () => {
    const p = parseRewindDiskPoint({
      prompt_index: 0,
      file_snapshots: { "x.txt": { path: "x.txt", captured_at: "t" } },
    });
    expect(p?.fileSnapshots["x.txt"].content).toBeNull();
  });

  it("resolveRewindWorkspacePath joins relative and keeps absolute", () => {
    expect(resolveRewindWorkspacePath("D:\\proj", "src\\a.ts").replace(/\//g, "\\")).toBe(
      "D:\\proj\\src\\a.ts",
    );
    expect(resolveRewindWorkspacePath("/tmp/w", "a/b.txt")).toBe("/tmp/w/a/b.txt");
    expect(resolveRewindWorkspacePath("/tmp/w", "/abs/x")).toBe("/abs/x");
    expect(resolveRewindWorkspacePath("D:\\proj", "C:\\other\\f.txt")).toBe("C:\\other\\f.txt");
  });
});

describe("history truncate backstop (updates.jsonl gap)", () => {
  const updates = [
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { text: "A" } } },
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "ra" } } },
    }),
    JSON.stringify({
      method: "_x.ai/session/update",
      params: { update: { sessionUpdate: "turn_completed" } },
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { text: "B" } } },
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "rb" } } },
    }),
    JSON.stringify({
      method: "session/update",
      params: { update: { sessionUpdate: "user_message_chunk", content: { text: "C" } } },
    }),
  ].join("\n") + "\n";

  it("truncateUpdatesJsonl keeps only prompts before target", () => {
    const t1 = truncateUpdatesJsonl(updates, 1);
    expect(t1).toContain('"text":"A"');
    expect(t1).toContain("turn_completed");
    expect(t1).not.toContain('"text":"B"');
    expect(t1).not.toContain('"text":"C"');
    // Counting user_message_chunk lines:
    expect([...t1.matchAll(/user_message_chunk/g)]).toHaveLength(1);

    const t0 = truncateUpdatesJsonl(updates, 0);
    expect(t0).toBe("");
  });

  it("truncateChatHistoryJsonl cuts at prompt_index >= target", () => {
    const ch =
      [
        JSON.stringify({ type: "system", content: "sys" }),
        JSON.stringify({ type: "user", content: "info", synthetic_reason: "x" }),
        JSON.stringify({ type: "user", content: "A", prompt_index: 0 }),
        JSON.stringify({ type: "assistant", content: "ra" }),
        JSON.stringify({ type: "user", content: "B", prompt_index: 1 }),
        JSON.stringify({ type: "assistant", content: "rb" }),
      ].join("\n") + "\n";
    const out = truncateChatHistoryJsonl(ch, 1);
    expect(out).toContain('"prompt_index":0');
    expect(out).toContain('"content":"ra"');
    expect(out).not.toContain('"prompt_index":1');
    expect(out).not.toContain('"content":"B"');
  });

  it("truncateRewindPointsJsonl drops points at/after target", () => {
    const rp =
      [
        JSON.stringify({ prompt_index: 0, prompt_preview: "A" }),
        JSON.stringify({ prompt_index: 1, prompt_preview: "B" }),
        JSON.stringify({ prompt_index: 2, prompt_preview: "C" }),
      ].join("\n") + "\n";
    const out = truncateRewindPointsJsonl(rp, 1);
    expect(out).toContain('"prompt_index":0');
    expect(out).not.toContain('"prompt_index":1');
    expect(out).not.toContain('"prompt_index":2');
  });
});
