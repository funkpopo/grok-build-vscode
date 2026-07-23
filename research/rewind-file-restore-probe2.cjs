// Probe: prove whether rewind/execute restores + deletes workspace files.
// Creates a session with a no-op turn, then a mutating turn (via ACP fs handlers),
// then rewinds to the no-op and checks disk.
// Usage: node research/rewind-file-restore-probe2.cjs
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwfile2-")));
fs.writeFileSync(path.join(cwd, "seed.txt"), "v1\n");

const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: { ...process.env, GROK_PERMISSION_MODE: "always-approve" } });
let nextId = 1;
let buf = "";
let sessionId;
const waiters = new Map();
let writes = 0;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      waiters.delete(id);
      rej(new Error(`timeout ${method}`));
    }, 180000);
    waiters.set(id, (msg) => {
      clearTimeout(t);
      res(msg);
    });
  });
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
        } catch (e) {
          respond(msg.id, {
            // Some CLIs expect error-shaped; empty content is fine for missing.
            content: "",
          });
        }
      } else if (msg.method === "fs/write_text_file") {
        const p = msg.params.path;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, msg.params.content ?? "");
        writes++;
        console.log("WRITE", p, JSON.stringify(String(msg.params.content ?? "").slice(0, 80)));
        respond(msg.id, {});
      } else if (msg.method === "terminal/create") {
        // Run real shell so agent can mutate if it prefers terminal.
        const { execSync } = require("node:child_process");
        const cmd = msg.params?.command || msg.params?.cmd || "";
        let output = "";
        let exitCode = 0;
        try {
          output = execSync(cmd, { cwd, encoding: "utf8", shell: true, timeout: 30000 });
        } catch (e) {
          exitCode = e.status || 1;
          output = (e.stdout || "") + (e.stderr || e.message);
        }
        const tid = "t" + writes;
        // stash on global
        globalThis.__term = globalThis.__term || {};
        globalThis.__term[tid] = { output, exitCode };
        console.log("TERM", cmd.slice(0, 120), "exit", exitCode);
        respond(msg.id, { terminalId: tid });
      } else if (msg.method === "terminal/output") {
        const t = (globalThis.__term || {})[msg.params.terminalId] || { output: "", exitCode: 0 };
        respond(msg.id, { output: t.output, truncated: false, exitCode: t.exitCode });
      } else if (msg.method === "terminal/wait_for_exit") {
        const t = (globalThis.__term || {})[msg.params.terminalId] || { exitCode: 0 };
        respond(msg.id, { exitCode: t.exitCode, signal: null });
      } else if (msg.method === "terminal/kill" || msg.method === "terminal/release") {
        respond(msg.id, {});
      } else {
        console.log("RPC", msg.method, JSON.stringify(msg.params || {}).slice(0, 120));
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", (d) => {
  const s = d.toString();
  if (/error|fail|rewind/i.test(s)) process.stderr.write(s);
});

function readState(label) {
  const seed = path.join(cwd, "seed.txt");
  const created = path.join(cwd, "created.txt");
  console.log(
    label,
    "writes=",
    writes,
    "files=",
    fs.readdirSync(cwd),
    "seed=",
    fs.existsSync(seed) ? JSON.stringify(fs.readFileSync(seed, "utf8")) : "MISSING",
    "created=",
    fs.existsSync(created) ? JSON.stringify(fs.readFileSync(created, "utf8")) : "MISSING",
  );
}

function dumpRp() {
  const rpPath = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    sessionId,
    "rewind_points.jsonl",
  );
  console.log("rp", rpPath, "exists", fs.existsSync(rpPath));
  if (!fs.existsSync(rpPath)) return;
  for (const line of fs.readFileSync(rpPath, "utf8").trim().split(/\n+/)) {
    try {
      const j = JSON.parse(line);
      const slim = {
        i: j.prompt_index,
        pre: Object.fromEntries(
          Object.entries(j.file_snapshots || {}).map(([k, v]) => [
            k,
            { contentNull: v.content == null, len: v.content == null ? null : String(v.content).length },
          ]),
        ),
        after: Object.fromEntries(
          Object.entries(j.after_snapshots || {}).map(([k, v]) => [
            k,
            { contentNull: v.content == null, len: v.content == null ? null : String(v.content).length },
          ]),
        ),
      };
      console.log("RP", JSON.stringify(slim));
    } catch (e) {
      console.log("RPerr", e.message);
    }
  }
}

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "rwfile2", version: "0" },
  });
  notify("authenticated", { methodId: "probe" });
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  console.log("session", sessionId, "cwd", cwd);
  readState("before");

  // Turn 0: no-op (baseline checkpoint)
  const p0 = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: ok. Do not use tools." }],
  });
  console.log("p0", p0.error || p0.result?.stopReason);
  readState("after-t0");

  // Turn 1: mutate files
  const p1 = await send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "You must use tools. Create created.txt with content exactly NEWFILE. " +
          "Overwrite seed.txt with content exactly V2. Then reply with exactly: done.",
      },
    ],
  });
  console.log("p1", p1.error || p1.result?.stopReason);
  readState("after-t1");
  dumpRp();

  const pts = (await send("_x.ai/rewind/points", { sessionId })).result;
  console.log("points", JSON.stringify(pts, null, 2));

  // Rewind to turn 0 — should delete created.txt and restore seed.txt to v1
  const exec = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 0,
    mode: "all",
    force: true,
  });
  console.log("EXEC→0", JSON.stringify(exec.result || exec.error, null, 2));
  readState("after-rewind-to-0");

  // Verdict
  const seedOk = fs.existsSync(path.join(cwd, "seed.txt")) && fs.readFileSync(path.join(cwd, "seed.txt"), "utf8") === "v1\n";
  const createdGone = !fs.existsSync(path.join(cwd, "created.txt"));
  console.log("VERDICT", {
    seedRestored: seedOk,
    createdDeleted: createdGone,
    writes,
    success: exec.result?.success,
    reverted: exec.result?.reverted_files,
    clean: exec.result?.clean_files,
    conflicts: exec.result?.conflicts,
  });

  try {
    proc.kill();
  } catch {}
  process.exit(seedOk && createdGone ? 0 : 2);
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
