// DOM tests for #41 — full command text + captured output on command rows,
// driving the REAL media/chat.js. The host snapshots each terminal's buffer at
// terminal/release (the extension runs the commands itself, so the output is
// exactly what grok received) and posts it as `commandOutput`; the webview
// renders a Claude-Code-style IN/OUT block under the row, collapsed by default
// with the tool-group header's chevron affordance. Outputs attach by
// exact-command FIFO, with a standalone fallback row so output is never
// dropped. Success is silent (exit 0 = just the output); failure gets an
// [Error] marker + error tint; a kill is [Cancelled], not an error.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const exec = (id: string, command: string, title?: string) => ({
  type: "toolCall",
  call: {
    toolCallId: id,
    kind: "execute",
    title: title ?? `Run ${command.slice(0, 20)}…`,
    rawInput: { variant: "Bash", command, is_background: false },
  },
});
const out = (command: string, output: string, exitCode: number | null = 0, truncated = false) => ({
  type: "commandOutput",
  command,
  output,
  exitCode,
  truncated,
});
const read = (id: string, path: string) => ({
  type: "toolCall",
  call: { toolCallId: id, kind: "read", title: `Read ${path}`, rawInput: { path } },
});
const close = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" });

describe("command details (#41)", () => {
  it("a lone command flattens WITH its trailing chevron + expandable IN/OUT block", () => {
    const { window, doc } = bootWebview();
    const longCmd = "node -e \"const fs=require('fs');const paths=fs.readdirSync('.').filter(p=>p.endsWith('.md'));console.log(paths.join('\\n'))\"";
    dispatch(window, exec("t1", longCmd, "Run node -e \"const fs=require('fs');const pa…"));
    close(window);

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    expect(flat).not.toBeNull();
    expect(flat.querySelector(".tool-chevron")).not.toBeNull(); // › after the label, moved with the flatten
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(true); // collapsed by default
    expect(flat.classList.contains("expanded")).toBe(false);

    click(window, flat);
    expect(details.hidden).toBe(false);
    expect(flat.classList.contains("expanded")).toBe(true); // › rotated to v

    // The FULL command under an IN tag, not grok's truncated title.
    expect(details.querySelector(".cmd-io-tag")!.textContent).toBe("IN");
    expect(details.querySelector(".tool-cmd")!.textContent).toBe(longCmd);

    // Output lands after the flatten — the moved node still receives it.
    // Success is silent: OUT tag + text, no exit marker.
    dispatch(window, out(longCmd, "CLAUDE.md\nREADME.md", 0));
    const outRow = details.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.querySelector(".cmd-io-tag")!.textContent).toBe("OUT");
    expect(outRow.querySelector(".tool-cmd-output")!.textContent).toBe("CLAUDE.md\nREADME.md");
    expect(outRow.classList.contains("failed")).toBe(false);
    expect(outRow.querySelector(".cmd-out-marker")).toBeNull();

    click(window, flat);
    expect(details.hidden).toBe(true);
    expect(flat.classList.contains("expanded")).toBe(false); // back to ›
  });

  it("Expand tool details is live-accordion only — finished rows stay collapsed", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec("a", "git status"));
    // Open while the batch is live.
    expect((doc.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(false);
    close(window);

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    // Accordion ends with the batch — settled content is collapsed.
    expect(details.hidden).toBe(true);
    expect(flat.classList.contains("expanded")).toBe(false);

    // Flipping the setting on a finished transcript does not re-open panels.
    dispatch(window, { type: "expandCommandOutputs", value: false });
    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(details.hidden).toBe(true);
  });

  it("outputs attach FIFO when the same command runs twice in one batch; exit 1 is [Error]", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "npm test"));
    close(window); // 2 calls → stays a group with .tool-item rows

    dispatch(window, out("npm test", "first run", 0));
    dispatch(window, out("npm test", "second run", 1));

    const items = [...doc.querySelectorAll(".tool-item.has-details")];
    expect(items).toHaveLength(2);
    // Labels in their own span (single-line ellipsis) + trailing chevron each.
    expect(items.every((i) => i.querySelector(".tool-item-label"))).toBe(true);
    expect(items.every((i) => i.querySelector(".tool-chevron"))).toBe(true);

    const details = [...doc.querySelectorAll(".tool-item .tool-item-details")];
    expect(details[0].querySelector(".tool-cmd-output")!.textContent).toBe("first run");
    expect(details[1].querySelector(".tool-cmd-output")!.textContent).toBe("second run");
    const failedRow = details[1].querySelector(".cmd-out") as HTMLElement;
    expect(failedRow.classList.contains("failed")).toBe(true);
    expect(failedRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    // The non-zero exit also rolls up to the ROW + GROUP (error at a glance,
    // consistent with a status:"failed" tool); the exit-0 row stays clean.
    expect(items[1].classList.contains("tool-failed")).toBe(true);
    expect(items[0].classList.contains("tool-failed")).toBe(false);
    expect((items[1].closest(".tool-group") as HTMLElement).classList.contains("has-error")).toBe(true);
  });

  it("a lone non-zero command flags its flattened row as failed (not just the OUT box)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("solo", "node build.js"));
    close(window); // 1 call → flattens to .tool-flat
    dispatch(window, out("node build.js", "boom", 1));
    const flat = doc.querySelector(".tool-flat") as HTMLElement;
    expect(flat.classList.contains("tool-failed")).toBe(true);
    expect(flat.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
  });

  it("an output with no matching row gets a standalone fallback row (never dropped)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, out("echo orphan", "orphan output", 0));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.querySelector(".tool-cmd")!.textContent).toBe("echo orphan");
    expect(details.querySelector(".tool-cmd-output")!.textContent).toBe("orphan output");
  });

  // The cursor/Composer agent runs commands in its OWN CLI-side shell (no
  // terminal/create), so `commandOutput` never fires for it — its output rides
  // the completed tool_call_update (rawOutput/content), keyed by toolCallId. The
  // #41 box must render it from there, or the row shows IN with no OUT (the bug).
  const completed = (id: string, output: string, exitCode = 0) => ({
    type: "toolCallUpdate",
    call: {
      toolCallId: id,
      status: "completed",
      rawOutput: { type: "Bash", output: [...Buffer.from(output, "utf8")], exit_code: exitCode, command: "x", truncated: false },
      content: [{ type: "content", content: { type: "text", text: output } }],
    },
  });

  it("fills a self-executed (Composer) command's OUT from the completed update, no terminal/create", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("c1", "git status --short"));
    close(window);
    // No commandOutput ever arrives (Composer never delegates). The completed
    // update carries the result instead.
    dispatch(window, completed("c1", " M CHANGELOG.md", 0));

    const rows = [...doc.querySelectorAll(".has-details")];
    expect(rows).toHaveLength(1); // no duplicate/standalone row
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe(" M CHANGELOG.md");
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("git status --short"); // IN unchanged
  });

  it("attaches self-executed outputs by toolCallId regardless of completion order (Composer runs parallel)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "git status --short"));
    dispatch(window, exec("b", "$env:USERNAME"));
    close(window); // 2 calls → stays a group with rows
    // Completions arrive OUT of issue order (b before a) — FIFO would swap them.
    dispatch(window, completed("b", "Dell", 0));
    dispatch(window, completed("a", "STATUS_OUT", 0));

    const items = [...doc.querySelectorAll(".tool-item.has-details")];
    expect(items).toHaveLength(2); // no duplicate rows
    const outFor = (id: string) =>
      (items.find((i) => i.querySelector(".tool-cmd")!.textContent ===
        (id === "a" ? "git status --short" : "$env:USERNAME"))!
        .querySelector(".tool-cmd-output") as HTMLElement).textContent;
    expect(outFor("a")).toBe("STATUS_OUT"); // each output on its OWN row, by id
    expect(outFor("b")).toBe("Dell");
  });

  it("a non-zero self-executed command shows [Error] exit N in its OUT box", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("e", "(cd x ; git status)"));
    close(window);
    dispatch(window, completed("e", "Missing closing ')' in expression.", 1));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(true);
    expect(outRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    expect(outRow.querySelector(".tool-cmd-output")!.textContent).toContain("Missing closing");
  });

  it("killed commands read [Cancelled] (muted, not an error); truncation is noted", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("k", "sleep 999"));
    close(window);
    dispatch(window, out("sleep 999", "partial", null, true));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(false);
    const markers = [...outRow.querySelectorAll(".cmd-out-marker")];
    expect(markers[0].textContent).toBe("[Cancelled] no exit code");
    expect(markers[0].classList.contains("muted")).toBe(true);
    expect(markers[1].textContent).toContain("output truncated");
  });

  it("an exit-0 command with no output shows a done marker, not an empty (no output) pre", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("q", "touch newfile"));
    close(window);
    dispatch(window, out("touch newfile", "", 0)); // success, nothing on stdout

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(false);
    const marker = outRow.querySelector(".cmd-out-marker") as HTMLElement;
    expect(marker.classList.contains("ok")).toBe(true);
    expect(marker.textContent).toContain("no output");
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull(); // no empty <pre>
  });

  it("whitespace-only output is treated as empty (no lingering pre)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("w", "echo"));
    close(window);
    dispatch(window, out("echo", "\n  \n", 0));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.querySelector(".cmd-out-marker.ok")).not.toBeNull();
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull();
  });

  it("a non-zero exit with no output shows only [Error], no (no output) filler", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("f", "false"));
    close(window);
    dispatch(window, out("false", "", 1));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(true);
    expect(outRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull();
  });

  it("clicking inside the expanded block (text selection) does not collapse it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("s", "git status"));
    close(window);
    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    click(window, flat);
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false);

    click(window, details.querySelector(".tool-cmd")!);
    expect(details.hidden).toBe(false); // still open
  });

  it("row chevrons are independent of the group's state (present mid-run, per-row rotation)", () => {
    const { window, doc } = bootWebview();
    // Accordion is gated on Expand tool details.
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status"));
    // Group still IN PROGRESS — live batch body is open; accordion opens only
    // the currently-running row's detail.
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect(group.classList.contains("expanded")).toBe(true);

    const rows = [...group.querySelectorAll(".tool-item.has-details")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.querySelector(".tool-chevron"))).toBe(true); // chevrons exist mid-run
    // Accordion: first run collapsed when second becomes active; second open.
    expect(rows[0].classList.contains("expanded")).toBe(false);
    expect(rows[1].classList.contains("expanded")).toBe(true);

    // User can still expand a settled prior row without closing the active one.
    click(window, rows[0]);
    expect(rows[0].classList.contains("expanded")).toBe(true);
    expect(rows[1].classList.contains("expanded")).toBe(true);
  });

  it("live accordion (Expand tool details ON): only the currently-running command's IN/OUT is open", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec("a", "npm test"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;

    // First run open while it is the active step.
    expect((group.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(false);
    expect(group.querySelector(".tool-item.tool-running .tool-cmd")!.textContent).toBe("npm test");

    dispatch(window, exec("b", "git status"));
    const details = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(details).toHaveLength(2);
    // Second run takes the open slot; first collapses.
    expect(details[0].hidden).toBe(true);
    expect(details[1].hidden).toBe(false);
    expect(details[1].querySelector(".tool-cmd")!.textContent).toBe("git status");

    dispatch(window, exec("c", "node -v"));
    const details3 = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(details3.map((d) => d.hidden)).toEqual([true, true, false]);
    expect(details3[2].querySelector(".tool-cmd")!.textContent).toBe("node -v");
  });

  it("accordion keeps a command's IN/OUT open when a non-detail tool (read) joins the batch", () => {
    // Regression: issuing a read after a command used to collapse the command's
    // panel and open nothing — accordion looked broken mid-turn.
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec("a", "npm test"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    const cmdDetails = group.querySelector(".tool-item-details") as HTMLElement;
    expect(cmdDetails.hidden).toBe(false);

    dispatch(window, read("r1", "src/a.ts"));
    // Read has no detail surface — open slot stays on the still-useful command.
    expect(cmdDetails.hidden).toBe(false);
    expect(group.querySelectorAll(".tool-item-details")).toHaveLength(1);
    expect(group.querySelectorAll(".tool-running")).toHaveLength(2); // both still in flight

    // A second command then takes the slot.
    dispatch(window, exec("b", "git status"));
    const details = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(details).toHaveLength(2);
    expect(details[0].hidden).toBe(true);
    expect(details[1].hidden).toBe(false);
  });

  it("turning Expand tool details ON mid-run opens only one detail slot (not every Running row)", () => {
    const { window, doc } = bootWebview(); // setting off
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status"));
    dispatch(window, exec("c", "node -v"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);

    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(group.classList.contains("expanded")).toBe(true);
    const details = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(details).toHaveLength(3);
    // Single open slot = newest running command, not all three.
    expect(details.map((d) => d.hidden)).toEqual([true, true, false]);
    expect(details[2].querySelector(".tool-cmd")!.textContent).toBe("node -v");
  });

  it("Expand tool details OFF: live batch stays collapsed (no accordion)", () => {
    const { window, doc } = bootWebview(); // setting off by default
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect(group.classList.contains("expanded")).toBe(false);
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
    const details = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(details.every((d) => d.hidden)).toBe(true);
    // User can still open a row manually.
    click(window, group.querySelector(".tool-group-header")!);
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(false);
    const rows = [...group.querySelectorAll(".tool-item.has-details")] as HTMLElement[];
    click(window, rows[0]);
    expect(details[0].hidden).toBe(false);
    expect(details[1].hidden).toBe(true); // no accordion — only the clicked one
  });

  it("Running stays on every in-flight tool until THAT tool completes (not only the last issued)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, read("r1", "a.ts"));
    dispatch(window, read("r2", "b.ts"));
    dispatch(window, read("r3", "c.ts"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    const rows = [...group.querySelectorAll(".tool-item")] as HTMLElement[];
    expect(rows).toHaveLength(3);
    // All three still in flight → all three show Running (old bug: only last).
    expect(rows.every((r) => r.classList.contains("tool-running"))).toBe(true);
    expect(group.querySelectorAll(".tool-run-pill")).toHaveLength(3);

    // First read completes — only r1 drops Running; r2/r3 keep it.
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "r1", status: "completed", kind: "read", title: "Read a.ts" },
    });
    expect(rows[0].classList.contains("tool-running")).toBe(false);
    expect(rows[0].querySelector(".tool-run-pill")).toBeNull();
    expect(rows[1].classList.contains("tool-running")).toBe(true);
    expect(rows[2].classList.contains("tool-running")).toBe(true);

    // Middle completes out of order — last remains the sole Running row.
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "r3", status: "completed", kind: "read", title: "Read c.ts" },
    });
    expect(rows[1].classList.contains("tool-running")).toBe(true);
    expect(rows[2].classList.contains("tool-running")).toBe(false);
    expect(group.querySelectorAll(".tool-run-pill")).toHaveLength(1);
  });

  it("a lone RUNNING command auto-expands with its IN detail when Expand tool details is on", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec("live", "npm run build"));
    // No close(): the batch is still in progress — accordion opens the active row.
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect(group.classList.contains("cmd-single")).toBe(true);
    expect(group.classList.contains("expanded")).toBe(true);

    const details = group.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false);
    expect(details.querySelector(".tool-cmd")!.textContent).toBe("npm run build");
    // OUT shows a live "Running…" placeholder until commandOutput lands.
    expect(details.querySelector(".cmd-running")).not.toBeNull();
    expect(group.querySelector(".tool-run-pill")!.textContent).toBe("Running");

    // A second tool joining the batch demotes it to normal group behavior and
    // accordion-collapses the first run's detail — but BOTH stay Running until
    // each settles (first is still in flight).
    dispatch(window, exec("live2", "git status"));
    expect(group.classList.contains("cmd-single")).toBe(false);
    const both = [...group.querySelectorAll(".tool-item-details")] as HTMLElement[];
    expect(both[0].hidden).toBe(true);
    expect(both[1].hidden).toBe(false);
    const rows = [...group.querySelectorAll(".tool-item")] as HTMLElement[];
    expect(rows.every((r) => r.classList.contains("tool-running"))).toBe(true);
  });

  it("a finished batch settles collapsed when Expand tool details is off", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status"));
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    // Setting off → no live auto-expand.
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);

    close(window);
    expect(group.classList.contains("in-progress")).toBe(false);
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
    expect(group.classList.contains("expanded")).toBe(false);
    // Per-row IN/OUT also settle closed when Expand tool details is off.
    expect([...group.querySelectorAll(".tool-item-details")].every((d) => (d as HTMLElement).hidden)).toBe(true);
    // Live chrome is gone.
    expect(group.querySelector(".tool-run-pill")).toBeNull();
    expect(group.querySelector(".cmd-running")).toBeNull();
  });

  it("non-command tools get no details block and no clickable-highlight class", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "r", kind: "read", rawInput: { path: "/a.ts" } } });
    close(window);
    expect(doc.querySelector(".tool-item-details")).toBeNull();
    expect(doc.querySelector(".has-details")).toBeNull();
  });

  it("the output poller and kill tools stay plain (no details, no highlight)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "p1", title: "Get task output: t1", rawInput: { variant: "TaskOutput", task_id: "t1", block: true } },
    });
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "p2", title: "kill_command_or_subagent", rawInput: { task_id: "t1" } },
    });
    close(window);
    expect(doc.querySelector(".has-details")).toBeNull();
    expect(doc.querySelector(".tool-item-details")).toBeNull();
  });
});

// Expand tool details is live-accordion only — finished groups stay collapsed.
describe("finished groups stay collapsed under Expand tool details", () => {
  it("a finished command-bearing group and an explore-only group both settle collapsed", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });

    // Batch 1: a command + a read → kept as a group, has a command detail row.
    dispatch(window, exec("c1", "git status"));
    dispatch(window, read("r1", "src/a.ts"));
    close(window);

    // Batch 2: two reads → kept as a group, NO command detail.
    dispatch(window, read("r2", "src/b.ts"));
    dispatch(window, read("r3", "src/c.ts"));
    close(window);

    const groups = [...doc.querySelectorAll(".tool-group")] as HTMLElement[];
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect((g.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
      expect(g.classList.contains("expanded")).toBe(false);
    }
  });

  it("toggling the setting on finished content does not re-open groups", () => {
    const { window, doc } = bootWebview();

    dispatch(window, exec("c1", "git status"));
    dispatch(window, read("r1", "src/a.ts"));
    close(window);
    dispatch(window, read("r2", "src/b.ts"));
    dispatch(window, read("r3", "src/c.ts"));
    close(window);

    const groups = [...doc.querySelectorAll(".tool-group")] as HTMLElement[];
    const cmdBody = groups.find((g) => g.querySelector(".has-details"))!.querySelector(".tool-group-body") as HTMLElement;
    const readBody = groups.find((g) => !g.querySelector(".has-details"))!.querySelector(".tool-group-body") as HTMLElement;
    expect(cmdBody.hidden).toBe(true);
    expect(readBody.hidden).toBe(true);

    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(cmdBody.hidden).toBe(true); // finished content is never auto-opened
    expect(readBody.hidden).toBe(true);
  });
});
