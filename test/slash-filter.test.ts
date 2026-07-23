import { describe, it, expect } from "vitest";
import {
  applySlashPick,
  EXTENSION_SLASH_COMMANDS,
  filterAdvertisedCommands,
  filterCommands,
  getSlashQuery,
  HIDDEN_SLASH_COMMANDS,
  isDisabledMediaSlash,
  matchSlashCommand,
  withExtensionSlashCommands,
} from "../src/slash-filter";

describe("getSlashQuery", () => {
  it("returns null when no slash at line start", () => {
    expect(getSlashQuery("hello", 5)).toBeNull();
    expect(getSlashQuery("hello /not", 10)).toBeNull();
  });

  it("returns query when slash is at start of input", () => {
    expect(getSlashQuery("/com", 4)).toBe("com");
  });

  it("returns query when slash is at start of new line", () => {
    expect(getSlashQuery("hi\n/pla", 7)).toBe("pla");
  });

  it("ignores text after the caret", () => {
    expect(getSlashQuery("/co  more", 3)).toBe("co");
  });

  it("returns empty string for bare `/`", () => {
    expect(getSlashQuery("/", 1)).toBe("");
  });
});

describe("filterCommands", () => {
  const cmds = [
    { name: "compact", description: "Compress conversation" },
    { name: "clear", description: "" },
    { name: "context", description: "Show context" },
    { name: "yolo", description: "Toggle auto-approve" },
  ];

  it("empty query returns all", () => {
    expect(filterCommands(cmds, "")).toEqual(cmds);
  });

  it("filters by prefix", () => {
    expect(filterCommands(cmds, "co").map((c) => c.name)).toEqual([
      "compact",
      "context",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(cmds, "CO").map((c) => c.name)).toEqual([
      "compact",
      "context",
    ]);
  });

  it("returns empty when no matches", () => {
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
});

describe("applySlashPick", () => {
  it("replaces the partial /q with /name and trailing space", () => {
    const r = applySlashPick("/com", 4, "compact");
    expect(r.text).toBe("/compact ");
    expect(r.caret).toBe(9);
  });

  it("preserves text after caret", () => {
    const r = applySlashPick("/co rest", 3, "compact");
    expect(r.text).toBe("/compact  rest");
    expect(r.caret).toBe(9);
  });

  it("works at start of new line", () => {
    const r = applySlashPick("hi\n/pla", 7, "plan");
    expect(r.text).toBe("hi\n/plan ");
    expect(r.caret).toBe(9);
  });
});

describe("filterAdvertisedCommands", () => {
  it("drops /always-approve (#31) and /context (#39) from the advertised list", () => {
    const cmds = [
      { name: "compact", description: "Compress conversation" },
      { name: "always-approve", description: "Auto-approve everything" },
      { name: "context", description: "Show context" },
      { name: "session-info", description: "Show session info" },
    ];
    expect(filterAdvertisedCommands(cmds).map((c) => c.name)).toEqual(["compact", "session-info"]);
  });

  it("leaves a list without hidden commands untouched", () => {
    const cmds = [{ name: "compact" }, { name: "session-info" }];
    expect(filterAdvertisedCommands(cmds)).toEqual(cmds);
  });

  it("HIDDEN_SLASH_COMMANDS contains always-approve and context", () => {
    expect(HIDDEN_SLASH_COMMANDS.has("always-approve")).toBe(true);
    expect(HIDDEN_SLASH_COMMANDS.has("context")).toBe(true);
  });

  it("keeps the resulting list out of the dispatch gate too", () => {
    const cmds = [{ name: "compact" }, { name: "always-approve" }];
    const names = filterAdvertisedCommands(cmds).map((c) => c.name);
    // Filtered out → matchSlashCommand won't recognize it as a command.
    expect(matchSlashCommand("/always-approve", names)).toBeNull();
    expect(matchSlashCommand("/compact", names)).toBe("compact");
  });

  it("hides /imagine and /imagine-video when media gen is disabled (0.2.111)", () => {
    const cmds = [
      { name: "compact" },
      { name: "imagine" },
      { name: "imagine-edit" },
      { name: "imagine-video" },
      { name: "session-info" },
    ];
    expect(
      filterAdvertisedCommands(cmds, { imageGen: false, videoGen: false }).map((c) => c.name),
    ).toEqual(["compact", "session-info"]);
    expect(
      filterAdvertisedCommands(cmds, { imageGen: true, videoGen: false }).map((c) => c.name),
    ).toEqual(["compact", "imagine", "imagine-edit", "session-info"]);
  });
});

describe("withExtensionSlashCommands", () => {
  it("injects /btw when the CLI does not advertise it (P3-16 autocomplete)", () => {
    const cmds = [
      { name: "compact", description: "Compress" },
      { name: "session-info", description: "Info" },
    ];
    const merged = withExtensionSlashCommands(cmds);
    expect(merged.map((c) => c.name)).toEqual(["btw", "compact", "doctor", "session-info"]);
    const btw = merged.find((c) => c.name === "btw");
    expect(btw?.description).toMatch(/side question/i);
  });

  it("injects /doctor when the CLI does not advertise it (P3-20 autocomplete)", () => {
    const cmds = [{ name: "compact" }];
    const merged = withExtensionSlashCommands(cmds);
    const doctor = merged.find((c) => c.name === "doctor");
    expect(doctor).toBeTruthy();
    expect(doctor?.description).toMatch(/diagnostic/i);
  });

  it("is idempotent when the CLI already advertises btw", () => {
    const cmds = [
      { name: "btw", description: "CLI copy" },
      { name: "compact" },
    ];
    const merged = withExtensionSlashCommands(cmds);
    expect(merged.filter((c) => c.name === "btw")).toHaveLength(1);
    expect(merged.find((c) => c.name === "btw")?.description).toBe("CLI copy");
  });

  it("EXTENSION_SLASH_COMMANDS includes btw and doctor", () => {
    expect(EXTENSION_SLASH_COMMANDS.some((c) => c.name === "btw")).toBe(true);
    expect(EXTENSION_SLASH_COMMANDS.some((c) => c.name === "doctor")).toBe(true);
  });

  it("prefix filter surfaces btw for /bt and /btw", () => {
    const cmds = withExtensionSlashCommands([
      { name: "compact" },
      { name: "session-info" },
    ]);
    expect(filterCommands(cmds, "bt").map((c) => c.name)).toEqual(["btw"]);
    expect(filterCommands(cmds, "btw").map((c) => c.name)).toEqual(["btw"]);
  });
});

describe("isDisabledMediaSlash", () => {
  it("flags image/video slash commands only when the matching flag is off", () => {
    expect(isDisabledMediaSlash("imagine", { image: false, video: true })).toBe(true);
    expect(isDisabledMediaSlash("imagine-video", { image: true, video: false })).toBe(true);
    expect(isDisabledMediaSlash("imagine", { image: true, video: true })).toBe(false);
    expect(isDisabledMediaSlash("compact", { image: false, video: false })).toBe(false);
    expect(isDisabledMediaSlash(null, { image: false, video: false })).toBe(false);
  });
});

describe("matchSlashCommand", () => {
  const commands = ["compact", "context", "imagine-video", "user:code-review"];

  it("matches an advertised command at position 0, with or without args", () => {
    expect(matchSlashCommand("/compact", commands)).toBe("compact");
    expect(matchSlashCommand("/compact focus on the tests", commands)).toBe("compact");
    expect(matchSlashCommand("/imagine-video a red cube", commands)).toBe("imagine-video");
    expect(matchSlashCommand("/user:code-review src/a.ts", commands)).toBe("user:code-review");
  });

  it("matches a multi-line prompt whose first line is the command", () => {
    expect(matchSlashCommand("/compact\n\nkeep the recent work", commands)).toBe("compact");
  });

  it("rejects prose that merely starts with a slash", () => {
    // Unix paths have no token boundary: `tmp` is followed by `/`, not whitespace.
    expect(matchSlashCommand("/tmp/foo is broken", commands)).toBeNull();
    expect(matchSlashCommand("/tmp/foo", ["tmp"])).toBeNull();
    expect(matchSlashCommand("please /compact", commands)).toBeNull();
    expect(matchSlashCommand("/", commands)).toBeNull();
    expect(matchSlashCommand("/ compact", commands)).toBeNull();
  });

  it("rejects unknown commands once the CLI has advertised its list", () => {
    expect(matchSlashCommand("/notacommand do it", commands)).toBeNull();
    expect(matchSlashCommand("/compact-ish", commands)).toBeNull();
  });

  it("falls back to shape alone before available_commands arrives", () => {
    expect(matchSlashCommand("/compact", [])).toBe("compact");
    expect(matchSlashCommand("/tmp/foo is broken", [])).toBeNull();
  });
});
