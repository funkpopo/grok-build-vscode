import { describe, it, expect } from "vitest";
import {
  BTW_SLASH_NAME,
  BTW_USAGE,
  extractBtwAnswer,
  isBtwSlash,
  parseBtwSlash,
} from "../src/btw";

describe("parseBtwSlash / isBtwSlash", () => {
  it("parses /btw with a question body", () => {
    expect(parseBtwSlash("/btw also check error handling")).toEqual({
      question: "also check error handling",
    });
    expect(parseBtwSlash("  /btw  what is 2+2?  ")).toEqual({
      question: "what is 2+2?",
    });
  });

  it("allows multi-line bodies", () => {
    expect(parseBtwSlash("/btw line one\nline two")).toEqual({
      question: "line one\nline two",
    });
  });

  it("returns empty question for bare /btw", () => {
    expect(parseBtwSlash("/btw")).toEqual({ question: "" });
    expect(parseBtwSlash("/btw   ")).toEqual({ question: "" });
  });

  it("is case-insensitive on the slash name (CLI advertises lowercase)", () => {
    expect(parseBtwSlash("/BTW hi")).toEqual({ question: "hi" });
    expect(isBtwSlash("/Btw x")).toBe(true);
  });

  it("rejects non-btw text and lookalikes", () => {
    expect(parseBtwSlash("btw no slash")).toBeNull();
    expect(parseBtwSlash("/btww extra letter")).toBeNull();
    expect(parseBtwSlash("/compact now")).toBeNull();
    expect(parseBtwSlash("please /btw later")).toBeNull();
    expect(isBtwSlash("hello")).toBe(false);
    expect(isBtwSlash("")).toBe(false);
  });

  it("exports the advertised slash name", () => {
    expect(BTW_SLASH_NAME).toBe("btw");
    expect(BTW_USAGE).toMatch(/\/btw/);
  });
});

describe("extractBtwAnswer", () => {
  it("unwraps the 0.2.111 double-nested result", () => {
    // Full JSON-RPC result field as returned by AcpClient.request
    expect(extractBtwAnswer({ result: { answer: "4" } })).toBe("4");
    expect(extractBtwAnswer({ result: { answer: "Paris" } })).toBe("Paris");
  });

  it("accepts a flat { answer } shape", () => {
    expect(extractBtwAnswer({ answer: "ok" })).toBe("ok");
  });

  it("returns undefined for missing / wrong shapes", () => {
    expect(extractBtwAnswer(undefined)).toBeUndefined();
    expect(extractBtwAnswer(null)).toBeUndefined();
    expect(extractBtwAnswer({})).toBeUndefined();
    expect(extractBtwAnswer({ result: {} })).toBeUndefined();
    expect(extractBtwAnswer({ result: { answer: 4 } })).toBeUndefined();
    expect(extractBtwAnswer({ answer: null })).toBeUndefined();
    expect(extractBtwAnswer("4")).toBeUndefined();
  });
});
