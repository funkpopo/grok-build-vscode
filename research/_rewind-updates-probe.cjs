// Probe: updates.jsonl structure before/after rewind (history truncate gap).
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK = path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwup-")));
const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
const waiters = new Map();
let buf = "";
let sessionId;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
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
        respond(msg.id, {});
      } else if (msg.method === "terminal/create") {
        respond(msg.id, { terminalId: "t" });
      } else if (msg.method === "terminal/output") {
        respond(msg.id, { output: "", truncated: false, exitCode: 0 });
      } else if (msg.method === "terminal/wait_for_exit") {
        respond(msg.id, { exitCode: 0, signal: null });
      } else {
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", () => {});

const sd = () => path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(cwd), sessionId);

function dumpUpdates(label) {
  const up = fs.readFileSync(path.join(sd(), "updates.jsonl"), "utf8").trim().split(/\n+/);
  console.log(label, "updates", up.length);
  up.forEach((l, i) => {
    const j = JSON.parse(l);
    const p = j.params || {};
    const u = p.update || {};
    const text = u.content?.text || u.title || "";
    const s = JSON.stringify(j);
    const m = s.match(/"prompt_index"\s*:\s*(\d+)/);
    console.log(
      JSON.stringify({
        i,
        method: j.method,
        su: u.sessionUpdate,
        text: String(text).replace(/\s+/g, " ").slice(0, 50),
        prompt_index: m ? Number(m[1]) : null,
        status: u.status || null,
      }),
    );
  });
}

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "rwup", version: "0" },
  });
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  for (const t of ["MSG_A only. No tools.", "MSG_B only. No tools.", "MSG_C only. No tools."]) {
    await send("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] });
  }
  dumpUpdates("BEFORE");
  const r = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 1,
    mode: "all",
    force: true,
  });
  console.log("exec", JSON.stringify(r.result || r.error));
  dumpUpdates("AFTER");
  const ch = fs.readFileSync(path.join(sd(), "chat_history.jsonl"), "utf8").trim().split(/\n+/);
  console.log("chat_history after", ch.length);
  ch.forEach((l, i) => {
    const j = JSON.parse(l);
    console.log(
      i,
      j.type,
      "pi=",
      j.prompt_index,
      "syn=",
      j.synthetic_reason || "",
      String(JSON.stringify(j.content || "")).replace(/\s+/g, " ").slice(0, 70),
    );
  });
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
