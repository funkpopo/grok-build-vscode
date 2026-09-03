/**
 * Deleting the conversation you are looking at must not mint a replacement
 * while siblings remain, and minting a blank session must not add a second
 * unused empty row in the same project.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import type { SessionListEntry } from "../src/sessions";

const cwd = "/work/accredia";

function listEntry(id: string, extra: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    id,
    cwd,
    displayName: extra.displayName ?? id,
    rawSummary: extra.rawSummary ?? id,
    updatedAt: extra.updatedAt ?? 1,
    createdAt: extra.createdAt ?? 1,
    numMessages: extra.numMessages ?? 1,
    ...extra,
  };
}

function sessionsMessage(entries: SessionListEntry[], activeId: string | null = null): HostMsg {
  return {
    type: "sessions",
    entries,
    activeId,
    dots: {},
    offset: 0,
    total: entries.length,
    hasMore: false,
    nextOffset: entries.length,
    query: "",
  };
}

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.cwd = cwd;
  sidebar.sessionLoadReservations = new Map();
  sidebar.sessionCache = new Map();
  sidebar.codexSessionCache = new Map();
  sidebar.claudeSessionCache = new Map();
  sidebar.worktreeCache = [];
  sidebar.selectedRepoCwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.state = {
    get: vi.fn((_key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, _key) ? memento[_key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    appendLine: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    fs: { delete: vi.fn(async () => {}) },
  };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.historyCwdFor = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.setSessionCwd = vi.fn((session: Session, next: string) => { session.cwd = next; });
  sidebar.defaultProviderForProject = vi.fn(() => "grok");
  sidebar.authorizedSessionCwds = vi.fn(() => [cwd]);
  sidebar.remoteAuthorizedSessionCwds = vi.fn(() => [cwd]);
  sidebar.sessionCwdsForRepo = vi.fn(() => [cwd]);
  sidebar.resolveLocalRepoTarget = vi.fn(() => ({ cwd, available: true }));
  sidebar.remoteSessionTarget = vi.fn(() => ({ cwd }));
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionName = vi.fn();
  sidebar.postMode = vi.fn();
  sidebar.sendLocalRepoSessionsPreview = vi.fn();
  sidebar.refreshRemoteRepoPreview = vi.fn();
  sidebar.removePlanReviews = vi.fn();
  sidebar.removeUploadsForSessions = vi.fn(async () => {});
  sidebar.removeSessionFromDisk = vi.fn();
  sidebar.discardAdapterEmptySession = vi.fn(async () => {});
  sidebar.persistWorktreeBinding = vi.fn(async () => {});
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.post = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  const sent: Array<{ clientId: string; msg: HostMsg }> = [];
  sidebar.sent = sent;
  sidebar.sendRemoteClient = vi.fn((clientId: string, msg: HostMsg) => { sent.push({ clientId, msg }); });
  sidebar.sendRemoteSessionList = vi.fn();
  sidebar.listEntries = [] as SessionListEntry[];
  sidebar.buildSessionsList = vi.fn(() => sessionsMessage(sidebar.listEntries));
  sidebar.startSession = vi.fn(async (_id?: string, session?: Session) => {
    const target = session ?? sidebar.focused;
    if (!target.activeSessionId) target.activeSessionId = `minted-${++sidebar.mintCount}`;
    target.client = { dispose() {}, sessionId: target.activeSessionId };
    sidebar.pool.add(target);
    return target.client;
  });
  sidebar.mintCount = 0;
  sidebar.disposeSession = vi.fn((session: Session) => {
    sidebar.pool.delete(session);
    sidebar.remoteClients.deleteActiveValue(session);
    session.client = undefined;
    return Promise.resolve();
  });
  return sidebar;
}

function liveSession(id: string, opts: { hasHistory?: boolean; cwd?: string } = {}): Session {
  const session = new Session();
  session.cwd = opts.cwd ?? cwd;
  session.activeSessionId = id;
  session.hasHistory = opts.hasHistory ?? true;
  session.client = { dispose() {}, sessionId: id } as Session["client"];
  return session;
}

function seedRemote(sidebar: any, clientId: string, session: Session): void {
  sidebar.remoteClients.ready(clientId);
  sidebar.remoteClients.select(clientId, session.cwd || cwd);
  sidebar.remoteClients.setActive(clientId, session);
  sidebar.pool.add(session);
}

describe("deleting a conversation re-homes to a neighbour", () => {
  it("focuses a sibling and creates nothing when the focused conversation has neighbours", async () => {
    const sidebar = makeSidebar();
    const focused = liveSession("empty-a", { hasHistory: false });
    const sibling = liveSession("kept-b");
    sidebar.focused = focused;
    sidebar.pool.add(focused);
    sidebar.pool.add(sibling);
    sidebar.listEntries = [listEntry("empty-a", { displayName: "New session", numMessages: 0 }), listEntry("kept-b")];

    const created: Session[] = [];
    const origNew = sidebar.newLocalSession.bind(sidebar);
    sidebar.newLocalSession = () => {
      const session = origNew();
      created.push(session);
      return session;
    };

    await sidebar.deleteSession("empty-a", undefined, "local");

    expect(sidebar.focused).toBe(sibling);
    expect(created).toEqual([]);
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.pool.has(focused)).toBe(false);
    expect(sidebar.pool.has(sibling)).toBe(true);
  });

  it("creates exactly one replacement when the last conversation in a project is deleted", async () => {
    const sidebar = makeSidebar();
    const focused = liveSession("only", { hasHistory: false });
    sidebar.focused = focused;
    sidebar.pool.add(focused);
    sidebar.listEntries = [listEntry("only", { displayName: "New session", numMessages: 0 })];

    await sidebar.deleteSession("only", undefined, "local");

    expect(sidebar.focused).not.toBe(focused);
    expect(sidebar.focused.activeSessionId).toBe("minted-1");
    expect(sidebar.startSession).toHaveBeenCalledTimes(1);
    expect(sidebar.pool.has(focused)).toBe(false);
    expect(sidebar.pool.has(sidebar.focused)).toBe(true);
  });

  it("lands a watcher of the deleted conversation on the same neighbour and does not move anyone else", async () => {
    const sidebar = makeSidebar();
    const deleted = liveSession("empty-a", { hasHistory: false });
    const neighbour = liveSession("kept-b");
    const other = liveSession("other-c");
    sidebar.focused = deleted;
    sidebar.pool.add(deleted);
    sidebar.pool.add(neighbour);
    sidebar.pool.add(other);
    sidebar.listEntries = [
      listEntry("empty-a", { displayName: "New session", numMessages: 0 }),
      listEntry("kept-b"),
      listEntry("other-c"),
    ];
    seedRemote(sidebar, "watcher", deleted);
    seedRemote(sidebar, "bystander", other);

    await sidebar.deleteSession("empty-a", undefined, "local");

    expect(sidebar.focused).toBe(neighbour);
    expect(sidebar.remoteClients.active("watcher")).toBe(neighbour);
    expect(sidebar.remoteClients.active("bystander")).toBe(other);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("does not yank the desk when a remote tab deletes a conversation the desk is not reading", async () => {
    const sidebar = makeSidebar();
    const desk = liveSession("desk-keep");
    const deleted = liveSession("phone-gone");
    const neighbour = liveSession("kept-b");
    sidebar.focused = desk;
    sidebar.pool.add(desk);
    sidebar.pool.add(deleted);
    sidebar.pool.add(neighbour);
    sidebar.listEntries = [listEntry("phone-gone"), listEntry("kept-b"), listEntry("desk-keep")];
    seedRemote(sidebar, "phone", deleted);

    await sidebar.deleteSession("phone-gone", undefined, "remote", "phone");

    expect(sidebar.focused).toBe(desk);
    expect(sidebar.remoteClients.active("phone")).toBe(neighbour);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("lands a watcher of the last conversation on the one replacement", async () => {
    const sidebar = makeSidebar();
    const deleted = liveSession("only", { hasHistory: false });
    sidebar.focused = deleted;
    sidebar.pool.add(deleted);
    sidebar.listEntries = [listEntry("only", { displayName: "New session", numMessages: 0 })];
    seedRemote(sidebar, "watcher", deleted);

    await sidebar.deleteSession("only", undefined, "local");

    expect(sidebar.focused.activeSessionId).toBe("minted-1");
    expect(sidebar.remoteClients.active("watcher")).toBe(sidebar.focused);
    expect(sidebar.startSession).toHaveBeenCalledTimes(1);
  });
});

describe("minting a blank session reuses an unused empty one", () => {
  it("adopts an existing unused empty conversation instead of adding a second", async () => {
    const sidebar = makeSidebar();
    const used = liveSession("used");
    const unused = liveSession("empty-wait", { hasHistory: false });
    sidebar.focused = used;
    sidebar.pool.add(used);
    sidebar.pool.add(unused);
    sidebar.listEntries = [
      listEntry("empty-wait", { displayName: "New session", numMessages: 0 }),
      listEntry("used"),
    ];

    const created: Session[] = [];
    const origNew = sidebar.newLocalSession.bind(sidebar);
    sidebar.newLocalSession = () => {
      const session = origNew();
      created.push(session);
      return session;
    };

    await sidebar.newFocusedSession("local");

    expect(sidebar.focused).toBe(unused);
    expect(created).toEqual([]);
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.pool.has(used)).toBe(true);
  });

  it("a remote new session adopts the same unused empty instead of minting another", async () => {
    const sidebar = makeSidebar();
    const used = liveSession("used");
    const unused = liveSession("empty-wait", { hasHistory: false });
    sidebar.focused = used;
    sidebar.pool.add(used);
    sidebar.pool.add(unused);
    sidebar.listEntries = [
      listEntry("empty-wait", { displayName: "New session", numMessages: 0 }),
      listEntry("used"),
    ];
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.select("phone", cwd);
    const phoneSession = liveSession("phone-used");
    sidebar.remoteClients.setActive("phone", phoneSession);
    sidebar.pool.add(phoneSession);

    await sidebar.newRemoteSession("phone", false);

    expect(sidebar.remoteClients.active("phone")).toBe(unused);
    expect(sidebar.focused).toBe(used);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });
});
