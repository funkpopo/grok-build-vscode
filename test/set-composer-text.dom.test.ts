// DOM test: setComposerText (P2-9 rewind) prefills the composer for re-edit.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

describe("setComposerText (rewind composer restore)", () => {
  it("replaces the composer text and focuses the input", () => {
    const { window, doc } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;

    input.value = "stale draft";
    const historyBtn = doc.getElementById("history-btn") as HTMLElement;
    historyBtn.focus();
    expect(doc.activeElement).toBe(historyBtn);

    dispatch(window, {
      type: "setComposerText",
      text: "MSG_B only. No tools.",
      focus: true,
    });

    expect(input.value).toBe("MSG_B only. No tools.");
    expect(doc.activeElement).toBe(input);
  });

  it("can skip focus when focus:false", () => {
    const { window, doc } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const historyBtn = doc.getElementById("history-btn") as HTMLElement;
    historyBtn.focus();

    dispatch(window, {
      type: "setComposerText",
      text: "no focus",
      focus: false,
    });

    expect(input.value).toBe("no focus");
    expect(doc.activeElement).toBe(historyBtn);
  });
});
