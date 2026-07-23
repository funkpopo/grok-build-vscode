// Why does Write fail over ACP without calling fs/write_text_file?
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const GROK = path.join(os.homedir(), ".grok", "bin", "grok.exe");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-w-")));
fs.writeFileSync(path.join(cwd, "a.txt"), "old\n");

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let id = 1;
let buf = "";
const W = new Map();

function send(m, p) {
  const i = id++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: m, params: p }) + "\n");
  return new Promise((r) => W.set(i, r));
}
function resp(i, r) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, result: r }) + "\n");
}

proc.stdout.on("data", (c) => {
  buf += c.toString();
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = W.get(msg.id);
      if (w) {
        W.delete(msg.id);
        w(msg);
      }
      continue;
    }
    if (msg.method) {
      console.log(
        "IN",
        msg.method,
        msg.id != null ? "req" : "note",
        JSON.stringify(msg.params || {}).slice(0, 400),
      );
      if (msg.id != null) {
        if (msg.method === "session/request_permission") {
          resp(msg.id, { outcome: { outcome: "selected", optionId: "allow-always" } });
        } else if (msg.method === "fs/read_text_file") {
          try {
            resp(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
          } catch {
            resp(msg.id, { content: "" });
          }
        } else if (msg.method === "fs/write_text_file") {
          console.log(">>> DO WRITE", msg.params.path);
          fs.writeFileSync(msg.params.path, msg.params.content ?? "");
          resp(msg.id, {});
        } else if (msg.method === "terminal/create") {
          resp(msg.id, { terminalId: "t1" });
        } else if (msg.method === "terminal/output") {
          resp(msg.id, { output: "", truncated: false, exitCode: 0 });
        } else if (msg.method === "terminal/wait_for_exit") {
          resp(msg.id, { exitCode: 0, signal: null });
        } else if (msg.method === "terminal/kill" || msg.method === "terminal/release") {
          resp(msg.id, {});
        } else {
          resp(msg.id, {});
        }
      }
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write(d));

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "w", version: "0" },
  });
  const s = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  await send("session/set_mode", { sessionId: s, modeId: "yolo" }).catch(() => {});
  const r = await send("session/prompt", {
    sessionId: s,
    prompt: [
      {
        type: "text",
        text: "Write the file a.txt with content hello. Use the Write/edit tool only. Then say done.",
      },
    ],
  });
  console.log("result", r.error || r.result);
  console.log("disk", fs.readFileSync(path.join(cwd, "a.txt"), "utf8"));
  // dump rp
  const rp = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    s,
    "rewind_points.jsonl",
  );
  if (fs.existsSync(rp)) console.log("rp", fs.readFileSync(rp, "utf8").slice(0, 500));
  try {
    proc.kill();
  } catch {}
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
});
