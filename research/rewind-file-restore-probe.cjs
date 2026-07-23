// Probe: does `_x.ai/rewind/execute` actually restore / delete workspace files?
// Usage: node research/rewind-file-restore-probe.cjs
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwfile-")));
fs.writeFileSync(path.join(cwd, "seed.txt"), "v1\n");

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
let buf = "";
let sessionId;
const waiters = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
      continue;
    }
    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        respond(msg.id, { outcome: { outcome: "selected", optionId: "allow-always" } });
      } else if (msg.method === "fs/read_text_file") {
        try {
          respond(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
        } catch {
          respond(msg.id, { content: "" });
        }
      } else if (msg.method === "fs/write_text_file") {
        fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
        fs.writeFileSync(msg.params.path, msg.params.content ?? "");
        console.log("WRITE", msg.params.path, JSON.stringify(msg.params.content));
        respond(msg.id, {});
      } else if (msg.method === "terminal/create") {
        respond(msg.id, { terminalId: "t" });
      } else if (msg.method === "terminal/output") {
        respond(msg.id, { output: "", truncated: false, exitCode: 0 });
      } else if (msg.method === "terminal/wait_for_exit") {
        respond(msg.id, { exitCode: 0, signal: null });
      } else if (msg.method === "terminal/kill" || msg.method === "terminal/release") {
        respond(msg.id, {});
      } else {
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", () => {});

function slimSnapshots(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      v && typeof v === "object"
        ? {
            path: v.path,
            len: String(v.content ?? "").length,
            keys: Object.keys(v),
            deleted: v.deleted,
            exists: v.exists,
          }
        : v,
    ]),
  );
}

function readState(label) {
  const seed = path.join(cwd, "seed.txt");
  const created = path.join(cwd, "created.txt");
  console.log(
    label,
    "files=",
    fs.readdirSync(cwd),
    "seed=",
    fs.existsSync(seed) ? JSON.stringify(fs.readFileSync(seed, "utf8")) : "MISSING",
    "created=",
    fs.existsSync(created) ? JSON.stringify(fs.readFileSync(created, "utf8")) : "MISSING",
  );
}

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "rwfile", version: "0" },
  });
  notify("authenticated", { methodId: "probe" });
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  console.log("session", sessionId, "cwd", cwd);
  readState("before");

  // Single file-mutating turn, then a noop turn so we can rewind past the mutation.
  const p1 = await send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "Create a new file named created.txt with content 'new'. " +
          "Overwrite seed.txt with content 'v2'. Then reply with exactly: done. Use write tools.",
      },
    ],
  });
  console.log("p1", p1.error || p1.result?.stopReason);
  readState("after-t1");

  const p2 = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: ok. No tools." }],
  });
  console.log("p2", p2.error || p2.result?.stopReason);

  const pts = (await send("_x.ai/rewind/points", { sessionId })).result;
  console.log("points", JSON.stringify(pts, null, 2));

  const rpPath = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    sessionId,
    "rewind_points.jsonl",
  );
  console.log("rp exists", fs.existsSync(rpPath), rpPath);
  if (fs.existsSync(rpPath)) {
    for (const line of fs.readFileSync(rpPath, "utf8").trim().split(/\n+/)) {
      try {
        const j = JSON.parse(line);
        const slim = {
          prompt_index: j.prompt_index,
          has_file_changes: j.has_file_changes,
          num_file_snapshots: j.num_file_snapshots,
          preview: String(j.prompt_preview || "").slice(0, 80),
        };
        for (const key of Object.keys(j)) {
          if (/snapshot/i.test(key) && j[key] && typeof j[key] === "object") {
            slim[key] = slimSnapshots(j[key]);
          }
        }
        console.log("RP", JSON.stringify(slim));
      } catch {
        console.log("RPraw", line.slice(0, 200));
      }
    }
  }

  // Rewind to prompt 0 (first user turn): keeps that turn's conversation;
  // files should restore to the snapshot taken for that point (pre- or post-?).
  const exec0 = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 0,
    mode: "all",
    force: true,
  });
  console.log("EXEC→0", JSON.stringify(exec0.result || exec0.error));
  readState("after-rewind-to-0");

  // Fresh session for undo-tip semantics: mutate, then rewind to a prior empty point.
  // If only one prompt, valid targets empty — need a primer-like prior point.
  // Create session2: mutate only (1 point). Can't rewind. So use session with
  // an initial no-op then mutate, rewind to no-op.
  try {
    proc.kill();
  } catch {}
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
