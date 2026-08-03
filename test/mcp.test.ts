import { describe, it, expect } from "vitest";
import {
  MCP_GLOBAL_SCOPE_WARNING,
  isMcpServerMethod,
  mcpServerDetail,
  mcpToolsRefreshedNote,
  mergeMcpServerLists,
  parseMcpCliList,
  parseMcpInitProgress,
  parseMcpInitialized,
  parseMcpListResult,
  parseMcpServerRecord,
  parseMcpServerStatus,
  parseMcpServersUpdated,
} from "../src/mcp";

describe("parseMcpListResult", () => {
  it("unwraps the double-wrapped ACP result", () => {
    const parsed = parseMcpListResult({
      result: {
        servers: [
          {
            name: "chrome-devtools",
            source: "local",
            type: "stdio",
            command: "npx",
            args: ["chrome-devtools-mcp@latest"],
            session: {
              enabled: true,
              status: "ready",
              tools: [
                { name: "click", description: "Clicks", enabled: true },
                { name: "navigate_page", enabled: false },
              ],
            },
          },
        ],
      },
    });
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      name: "chrome-devtools",
      enabled: true,
      status: "ready",
      source: "local",
      type: "stdio",
      command: "npx",
      toolCount: 2,
    });
  });

  it("reads session.enabled over a top-level enabled when both exist", () => {
    const s = parseMcpServerRecord({
      name: "x",
      enabled: true,
      session: { enabled: false, status: "disabled" },
    });
    expect(s).toMatchObject({ name: "x", enabled: false, status: "disabled" });
  });

  it("returns an empty list for garbage", () => {
    expect(parseMcpListResult(null).servers).toEqual([]);
    expect(parseMcpListResult("nope").servers).toEqual([]);
    expect(parseMcpListResult({}).servers).toEqual([]);
  });
});

describe("parseMcpCliList", () => {
  it("parses the project/user JSON rows from grok mcp list --json", () => {
    const parsed = parseMcpCliList(JSON.stringify([
      {
        name: "test-echo",
        command: "npx",
        args: ["-y", "mcp-server-everything"],
        enabled: false,
        scope: "project",
      },
    ]));
    expect(parsed.servers).toEqual([
      {
        name: "test-echo",
        enabled: false,
        scope: "project",
        command: "npx",
        args: ["-y", "mcp-server-everything"],
      },
    ]);
  });

  it("treats empty / non-JSON stdout as no servers", () => {
    expect(parseMcpCliList("").servers).toEqual([]);
    expect(parseMcpCliList("[]").servers).toEqual([]);
    expect(parseMcpCliList("not json").servers).toEqual([]);
  });
});

describe("MCP push rails", () => {
  it("parses servers_updated", () => {
    const u = parseMcpServersUpdated({
      mcpServers: [
        { name: "a", source: "local", type: "stdio", command: "npx", args: ["x"] },
      ],
    });
    expect(u?.servers).toHaveLength(1);
    expect(u?.servers[0].name).toBe("a");
    expect(u?.servers[0].enabled).toBe(true);
  });

  it("parses mcp_initialized + init_progress + server_status", () => {
    expect(parseMcpInitialized({
      sessionId: "s1",
      mcpToolCount: 29,
      elapsedMs: 1200,
    })).toEqual({ sessionId: "s1", mcpToolCount: 29, elapsedMs: 1200 });

    expect(parseMcpInitProgress({
      sessionId: "s1",
      total: 2,
      connected: 1,
    })).toEqual({ sessionId: "s1", total: 2, connected: 1 });

    expect(parseMcpServerStatus({
      sessionId: "s1",
      name: "chrome-devtools",
      source: "local",
      status: "ready",
      reason: "initialized",
    })).toEqual({
      sessionId: "s1",
      name: "chrome-devtools",
      source: "local",
      status: "ready",
      reason: "initialized",
    });
  });

  it("recognizes MCP server method names", () => {
    expect(isMcpServerMethod("_x.ai/mcp/servers_updated")).toBe(true);
    expect(isMcpServerMethod("_x.ai/mcp_initialized")).toBe(true);
    expect(isMcpServerMethod("_x.ai/mcp/init_progress")).toBe(true);
    expect(isMcpServerMethod("_x.ai/mcp/server_status")).toBe(true);
    expect(isMcpServerMethod("_x.ai/session_notification")).toBe(false);
  });
});

describe("merge + labels", () => {
  it("merges session status onto CLI scope rows", () => {
    const merged = mergeMcpServerLists(
      [{ name: "a", enabled: true, status: "ready", toolCount: 3 }],
      [{ name: "a", enabled: false, scope: "project", command: "npx" },
       { name: "b", enabled: true, scope: "user" }],
    );
    expect(merged.map((s) => s.name)).toEqual(["a", "b"]);
    expect(merged[0]).toMatchObject({
      name: "a",
      enabled: true,
      status: "ready",
      scope: "project",
      toolCount: 3,
      command: "npx",
    });
  });

  it("builds a scannable detail line and refreshed note", () => {
    expect(mcpServerDetail({
      name: "a",
      enabled: true,
      scope: "project",
      status: "ready",
      toolCount: 2,
      command: "npx",
      args: ["-y", "pkg"],
    })).toBe("project · ready · 2 tools · npx -y pkg");

    expect(mcpToolsRefreshedNote(29)).toBe("MCP tools refreshed (29 tools).");
    expect(mcpToolsRefreshedNote(1)).toBe("MCP tools refreshed (1 tool).");
    expect(mcpToolsRefreshedNote()).toBe("MCP tools refreshed.");
    expect(MCP_GLOBAL_SCOPE_WARNING).toMatch(/global/i);
  });
});
