// Load an existing session and execute rewind; watch disk + fs/write RPCs.
// Usage: node research/rewind-load-execute-probe.cjs [cwd] [sessionId] [targetPromptIndex]
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = path.resolve(process.argv[2] || process.cwd());
const sessionId = process.argv[3];
const target = Number(process.argv[4] ?? 0);
if (!sessionId) {
  console.error("usage: node research/rewind-load-execute-probe.cjs <cwd> <sessionId> [targetPromptIndex]");
  process.exit(1);
}

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
let buf = "";
const waiters = new Map();
const writes = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      waiters.delete(id);
      rej(new Error(`timeout ${method}`));
    }, 120000);
    waiters.set(id, (msg) => {
      clearTimeout(t);
      res(msg);
    });
  });
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
        const p = msg.params.path;
        const content = msg.params.content ?? "";
        writes.push({ path: p, len: String(content).length, head: String(content).slice(0, 40) });
        console.log("ACP WRITE", p, "len", String(content).length);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
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
        console.log("RPC", msg.method);
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write(d));

function fileState(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  if (!fs.existsSync(p)) return "MISSING";
  return JSON.stringify(fs.readFileSync(p, "utf8").slice(0, 80));
}

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "rw-load", version: "0" },
  });
  const loaded = await send("session/load", { cwd, sessionId, mcpServers: [] });
  if (loaded.error) {
    console.log("load error", loaded.error);
    process.exit(1);
  }
  console.log("loaded", loaded.result?.sessionId || sessionId);
  const pts = await send("_x.ai/rewind/points", { sessionId });
  console.log("points", JSON.stringify(pts.result || pts.error, null, 2));
  console.log("test.txt before", fileState("test.txt"));
  const exec = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: target,
    mode: "all",
    force: true,
  });
  console.log("EXEC", JSON.stringify(exec.result || exec.error, null, 2));
  console.log("ACP writes during execute:", writes.length, writes);
  console.log("test.txt after", fileState("test.txt"));
  // Also check a couple of larger files mentioned in snapshots
  for (const rel of ["src/sidebar.ts", "media/chat.js"]) {
    const p = path.join(cwd, rel);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      console.log(rel, "size", st.size, "mtime", st.mtime.toISOString());
    }
  }
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
