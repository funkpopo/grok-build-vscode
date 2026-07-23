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
  parseRewindPointsJsonl,
  parseRewindDiskPoint,
  computeRewindRestoreActions,
  resolveRewindWorkspacePath,
  summarizeRewindRestoreActions,
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

  it("drops the latest tip (no-op target)", () => {
    const sel = selectableRewindPoints(pts);
    expect(sel.map((p) => p.promptIndex)).toEqual([0, 1]);
  });

  it("returns [] when only one point exists", () => {
    expect(selectableRewindPoints([pts[0]])).toEqual([]);
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
    expect(msg).toMatch(/Rewind to this message/i);
    expect(msg).toContain("beta");
    expect(msg).toMatch(/discarded|restored/i);
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

  it("returns null for a later tip bubble and out-of-range", () => {
    expect(resolveUserBubbleRewind(all, 2)).toBeNull(); // tip, not first-only
    expect(resolveUserBubbleRewind(all, 99)).toBeNull();
    expect(resolveUserBubbleRewind(all, -1)).toBeNull();
  });

  it("first sole user message undoes via the previous checkpoint (primer)", () => {
    const sole = [primer, u0];
    const r = resolveUserBubbleRewind(sole, 0);
    expect(r?.undoingTip).toBe(true);
    expect(r?.bubble.promptIndex).toBe(1);
    expect(r?.execute.promptIndex).toBe(0); // primer
    expect(previousRewindPoint(sole, 1)?.promptIndex).toBe(0);
  });

  it("works when there is no primer", () => {
    const bare = [u0, u1].map((p, i) => ({ ...p, promptIndex: i }));
    expect(resolveUserBubbleRewind(bare, 0)?.execute.promptIndex).toBe(0);
    expect(resolveUserBubbleRewind(bare, 1)).toBeNull();
    // Sole message with no prior checkpoint → can't execute.
    expect(resolveUserBubbleRewind([{ ...u0, promptIndex: 0 }], 0)).toBeNull();
  });

  it("confirm copy distinguishes undo-tip vs rewind-to", () => {
    const undo = rewindConfirmMessage(u0, "all", { undoingTip: true });
    expect(undo).toMatch(/Discard this turn/i);
    const to = rewindConfirmMessage(u0, "all");
    expect(to).toMatch(/Rewind to this message/i);
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

  it("rewinding to baseline deletes new files and restores prior content", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    const actions = computeRewindRestoreActions(pts, 0);
    // earliest later point is #1: created→delete, seed→v1
    // point #2's seed is skipped (already seen); other.ts added from #2
    expect(actions).toEqual([
      { kind: "delete", path: "created.txt" },
      { kind: "write", path: "other.ts", content: "a" },
      { kind: "write", path: "seed.txt", content: "v1\n" },
    ]);
    const sum = summarizeRewindRestoreActions(actions);
    expect(sum.deleted).toBe(1);
    expect(sum.written).toBe(2);
  });

  it("rewinding to turn 1 only undoes turn 2+", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    const actions = computeRewindRestoreActions(pts, 1);
    // created.txt was born in turn 1 — keep it (not in later pre-snaps as first touch)
    expect(actions).toEqual([
      { kind: "write", path: "other.ts", content: "a" },
      { kind: "write", path: "seed.txt", content: "V2\n" },
    ]);
  });

  it("rewinding to tip yields no file actions", () => {
    const pts = parseRewindPointsJsonl(jsonl);
    expect(computeRewindRestoreActions(pts, 2)).toEqual([]);
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
