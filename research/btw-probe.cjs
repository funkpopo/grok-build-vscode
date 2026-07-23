// Probe `_x.ai/btw` — mid-session side question that must NOT cancel or steer
// the main turn (distinct from `_x.ai/interject` / #52 Steer).
//
// BtwRequest has 2 elements (binary typeinfo); candidates are sessionId + text
// (or question/prompt). Response shape unknown — dump everything.
//
// Usage:
//   node research/btw-probe.cjs
//   node research/btw-probe.cjs --mid-turn
//   GROK_BIN=… node research/btw-probe.cjs

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const MID_TURN = process.argv.includes("--mid-turn");
const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-btw-")));
fs.writeFileSync(path.join(cwd, "note.txt"), "hello from btw probe\n");

function log(s) {
  process.stderr.write(`[btw] ${s}\n`);
}

const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: { ...process.env } });
let nextId = 1;
const waiters = new Map();
let textBuf = "";
const inbound = {};
const notifications = [];
const messageChunks = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function respondErr(id, code, message) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
proc.stderr.on("data", (d) => {
  const s = String(d);
  if (/btw|side.?question|aside/i.test(s)) log("STDERR " + s.trim().slice(0, 300));
});
proc.on("error", (e) => {
  log("SPAWN ERROR " + e.message);
  process.exit(2);
});

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method && msg.id != null) {
    inbound[msg.method] = (inbound[msg.method] || 0) + 1;
    const m = msg.method;
    if (m === "fs/read_text_file") {
      let content = "";
      try {
        content = fs.readFileSync(msg.params.path, "utf8");
      } catch {}
      return respond(msg.id, { content });
    }
    if (m === "fs/write_text_file") {
      try {
        fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
        fs.writeFileSync(msg.params.path, msg.params.content || "");
      } catch {}
      return respond(msg.id, {});
    }
    if (m === "terminal/create") return respond(msg.id, { terminalId: "t" + nextId });
    if (m === "terminal/output")
      return respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    if (m === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
    if (m.startsWith("terminal/")) return respond(msg.id, {});
    if (m === "session/request_permission") {
      const opts = (msg.params && msg.params.options) || [];
      const allow = opts.find((o) => /allow/.test(o.kind)) || opts[0];
      return respond(msg.id, { outcome: { outcome: "selected", optionId: allow && allow.optionId } });
    }
    if (/ask_user_question|exit_plan_mode/.test(m)) return respond(msg.id, { outcome: "cancelled" });
    return respond(msg.id, {});
  }

  if (msg.method) {
    inbound[msg.method] = (inbound[msg.method] || 0) + 1;
    if (/session_notification|session\/update/.test(msg.method)) {
      const u = (msg.params && (msg.params.update || msg.params)) || {};
      notifications.push({ method: msg.method, update: u });
      const kind =
        u.sessionUpdate ||
        (u.update && u.update.sessionUpdate) ||
        u.kind ||
        Object.keys(u).slice(0, 6).join(",");
      if (/btw|side|aside|interjection/i.test(JSON.stringify(u)) || /btw|side|aside/i.test(String(kind))) {
        log(`NOTIFY ${msg.method} kind=${JSON.stringify(kind).slice(0, 100)}`);
        log(`  payload: ${JSON.stringify(u).slice(0, 500)}`);
      }
    }
    if (msg.method === "session/update") {
      const u = (msg.params && msg.params.update) || {};
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        textBuf += u.content.text;
        messageChunks.push({ t: Date.now(), text: u.content.text, source: "session/update" });
      }
    }
    return;
  }

  if (msg.id != null) {
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms)),
  ]);
}

async function initAndNew() {
  const init = await withTimeout(
    send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    }),
    60000,
    "initialize",
  );
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  const ns = await withTimeout(send("session/new", { cwd, mcpServers: [] }), 120000, "session/new");
  if (ns.error) throw new Error("session/new: " + JSON.stringify(ns.error));
  return ns.result;
}

function findSessionDir(sessionId) {
  const base = path.join(os.homedir(), ".grok", "sessions");
  try {
    for (const group of fs.readdirSync(base)) {
      const dir = path.join(base, group, sessionId);
      if (fs.existsSync(dir)) return dir;
    }
  } catch {}
  return undefined;
}

async function main() {
  let ver = "?";
  try {
    ver = require("node:child_process").execFileSync(GROK, ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  log(`grok=${ver} midTurn=${MID_TURN}`);

  const { sessionId } = await initAndNew();
  log("session " + sessionId);

  // Seed a short turn so the session has context.
  textBuf = "";
  const seed = send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: READY. Do not use tools." }],
  });
  const seedDone = await withTimeout(seed, 180000, "seed");
  log(`seed stop=${seedDone.result?.stopReason} text=${JSON.stringify(textBuf.trim().slice(0, 80))}`);

  const shapes = [
    ["sessionId+text", { sessionId, text: "What is 2+2? Reply with one number only." }],
    ["sessionId+question", { sessionId, question: "What is 2+2? Reply with one number only." }],
    ["sessionId+prompt", { sessionId, prompt: "What is 2+2? Reply with one number only." }],
    ["sessionId+message", { sessionId, message: "What is 2+2? Reply with one number only." }],
    ["text only", { text: "What is 2+2? Reply with one number only." }],
  ];

  let accepted = null;
  let longTurnPromise = null;

  if (MID_TURN) {
    textBuf = "";
    longTurnPromise = send("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text:
            "Count slowly from 1 to 40, writing each number on its own line. " +
            "Do not use tools. After finishing the count, write DONE.",
        },
      ],
    });
    // Wait until streaming
    const t0 = Date.now();
    while (textBuf.length < 10 && Date.now() - t0 < 90000) await sleep(200);
    log(`mid-turn live after ${Date.now() - t0}ms (${textBuf.length} chars)`);
  }

  for (const [label, params] of shapes) {
    const beforeLen = textBuf.length;
    const r = await withTimeout(send("_x.ai/btw", params), 120000, "btw:" + label).catch((e) => ({
      error: { message: String(e) },
    }));
    const afterLen = textBuf.length;
    const summary = r.error
      ? `ERR ${r.error.code ?? ""} ${r.error.message}`
      : `OK ${JSON.stringify(r.result).slice(0, 400)}`;
    log(`_x.ai/btw {${label}}: ${summary}`);
    log(`  textBuf delta: ${afterLen - beforeLen} chars`);
    if (!r.error) {
      accepted = { label, params, result: r.result };
      // Wait a bit for any delayed notification / chunks
      await sleep(2000);
      break;
    }
    // -32601 method missing — stop trying shapes
    if (r.error && r.error.code === -32601) {
      log("method not found — stop");
      break;
    }
  }

  // Also try slash-command form via session/prompt (idle only)
  if (!MID_TURN && !accepted) {
    textBuf = "";
    const slash = await withTimeout(
      send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/btw What is 3+3? One number only." }],
      }),
      180000,
      "slash-btw",
    );
    log(`/btw via session/prompt: stop=${slash.result?.stopReason} err=${JSON.stringify(slash.error)} text=${JSON.stringify(textBuf.trim().slice(0, 200))}`);
  }

  // If accepted mid-turn, wait for main turn to finish and check it wasn't cancelled
  if (longTurnPromise) {
    const main = await withTimeout(longTurnPromise, 300000, "main-turn").catch((e) => ({
      error: { message: String(e) },
    }));
    log(
      `main turn stop=${main.result?.stopReason} err=${JSON.stringify(main.error)} textTail=${JSON.stringify(textBuf.trim().slice(-120))}`,
    );
  }

  // Dump btw_history if present
  const dir = findSessionDir(sessionId);
  if (dir) {
    const btwPath = path.join(dir, "btw_history.jsonl");
    if (fs.existsSync(btwPath)) {
      log("btw_history.jsonl:\n" + fs.readFileSync(btwPath, "utf8").slice(0, 2000));
    } else {
      log("no btw_history.jsonl at " + btwPath);
      try {
        log("session dir files: " + fs.readdirSync(dir).join(", "));
      } catch {}
    }
  }

  // Interesting notifications
  const interesting = notifications.filter((n) =>
    /btw|side|aside|interjection|question/i.test(JSON.stringify(n)),
  );
  log(`inbound methods: ${JSON.stringify(inbound)}`);
  log(`interesting notifications: ${interesting.length}`);
  for (const n of interesting.slice(0, 10)) {
    log("  " + JSON.stringify(n).slice(0, 500));
  }
  log(`accepted shape: ${accepted ? accepted.label : "NONE"}`);
  if (accepted) log(`accepted result: ${JSON.stringify(accepted.result).slice(0, 800)}`);

  try {
    proc.kill();
  } catch {}
  process.exit(0);
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
