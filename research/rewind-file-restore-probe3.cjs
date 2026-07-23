// Deterministic rewind file restore probe.
// Bypasses the model for file mutation: we write files ourselves between
// prompts so the only question is whether rewind/execute reverts disk.
//
// Caveat: CLI may only snapshot files it saw via tools. So turn 1 still asks
// the model to write — if that fails, we fall back to reporting "no snapshots".
//
// Usage: node research/rewind-file-restore-probe3.cjs
const { spawn, execSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwfile3-")));
fs.writeFileSync(path.join(cwd, "seed.txt"), "v1\n");

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
let buf = "";
let sessionId;
const waiters = new Map();
let acpWrites = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      waiters.delete(id);
      rej(new Error(`timeout ${method}`));
    }, 300000);
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
    // Log interesting session updates
    if (msg.method === "session/update" || msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        console.log("UPD", u.sessionUpdate, u.title || u.status || "", u.kind || "");
      }
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.text) {
        process.stdout.write("MSG:" + u.content.text);
      }
    }
    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        respond(msg.id, { outcome: { outcome: "selected", optionId: "allow-always" } });
      } else if (msg.method === "fs/read_text_file") {
        try {
          respond(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
        } catch {
          // missing file — return error-ish empty; CLI may treat as missing
          respond(msg.id, { content: "" });
        }
      } else if (msg.method === "fs/write_text_file") {
        const p = msg.params.path;
        const content = msg.params.content ?? "";
        acpWrites.push(p);
        console.log("\nWRITE", p, JSON.stringify(String(content).slice(0, 40)));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        respond(msg.id, {});
      } else if (msg.method === "terminal/create") {
        const cmd = msg.params.command || "";
        let output = "";
        let exitCode = 0;
        try {
          output = execSync(cmd, { cwd, encoding: "utf8", shell: true, timeout: 60000 });
        } catch (e) {
          exitCode = typeof e.status === "number" ? e.status : 1;
          output = String(e.stdout || "") + String(e.stderr || e.message || "");
        }
        const tid = "t" + acpWrites.length + Math.random().toString(16).slice(2, 6);
        globalThis.__term = globalThis.__term || {};
        globalThis.__term[tid] = { output, exitCode };
        console.log("\nTERM", cmd.slice(0, 100), "→", exitCode);
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
        console.log("\nRPC", msg.method);
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", (d) => {
  const s = d.toString();
  if (!/DEBUG|trace/i.test(s)) process.stderr.write(s);
});

function state(label) {
  console.log(
    "\n[" + label + "]",
    "files=",
    fs.readdirSync(cwd),
    "seed=",
    fs.existsSync(path.join(cwd, "seed.txt"))
      ? JSON.stringify(fs.readFileSync(path.join(cwd, "seed.txt"), "utf8"))
      : "MISSING",
    "created=",
    fs.existsSync(path.join(cwd, "created.txt"))
      ? JSON.stringify(fs.readFileSync(path.join(cwd, "created.txt"), "utf8"))
      : "MISSING",
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
  if (!fs.existsSync(rpPath)) {
    console.log("no rp", rpPath);
    return;
  }
  for (const line of fs.readFileSync(rpPath, "utf8").trim().split(/\n+/)) {
    const j = JSON.parse(line);
    const slim = (snaps) =>
      Object.fromEntries(
        Object.entries(snaps || {}).map(([k, v]) => [
          k,
          v.content == null ? "NULL" : `len=${String(v.content).length}`,
        ]),
      );
    console.log("RP#" + j.prompt_index, "pre", slim(j.file_snapshots), "after", slim(j.after_snapshots));
  }
}

(async () => {
  console.log("cwd", cwd, "grok", GROK);
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "rwfile3", version: "0" },
  });
  // Prefer auto-approve mode if available
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  try {
    await send("session/set_mode", { sessionId, modeId: "yolo" });
    console.log("mode yolo ok");
  } catch (e) {
    console.log("set_mode", e.message);
  }
  try {
    await send("session/set_mode", { sessionId, modeId: "default" });
  } catch {}

  state("start");

  // Baseline turn
  let r = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: ok. No tools." }],
  });
  console.log("\nturn0", r.error || r.result?.stopReason);
  state("after0");

  // Mutating turn — ask for Write tool explicitly
  r = await send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "Use the Write tool (fs write) twice:\n" +
          "1) path created.txt content NEWFILE\\n\n" +
          "2) path seed.txt content V2\\n\n" +
          "Do not use a shell. After both writes succeed, reply: done",
      },
    ],
  });
  console.log("\nturn1", r.error || r.result?.stopReason, "acpWrites", acpWrites);
  state("after1");
  dumpRp();

  // If model didn't write, force-create files so we can at least see execute behavior
  // when snapshots are empty (expected: nothing reverts).
  if (!fs.existsSync(path.join(cwd, "created.txt"))) {
    console.log("MODEL DID NOT WRITE — creating files outside tools (snapshots likely empty)");
    fs.writeFileSync(path.join(cwd, "created.txt"), "NEWFILE\n");
    fs.writeFileSync(path.join(cwd, "seed.txt"), "V2\n");
    state("forced-mutate");
    dumpRp();
  }

  const pts = await send("_x.ai/rewind/points", { sessionId });
  console.log("points", JSON.stringify(pts.result, null, 2));

  acpWrites = [];
  const exec = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 0,
    mode: "all",
    force: true,
  });
  console.log("EXEC", JSON.stringify(exec.result || exec.error, null, 2));
  console.log("ACP writes during execute:", acpWrites);
  state("after-rewind");
  dumpRp();

  const seed = fs.existsSync(path.join(cwd, "seed.txt"))
    ? fs.readFileSync(path.join(cwd, "seed.txt"), "utf8")
    : null;
  const createdExists = fs.existsSync(path.join(cwd, "created.txt"));
  const ok =
    seed === "v1\n" &&
    !createdExists &&
    (exec.result?.reverted_files?.length || 0) > 0;
  console.log("VERDICT", {
    seed,
    createdExists,
    reverted: exec.result?.reverted_files,
    clean: exec.result?.clean_files,
    conflicts: exec.result?.conflicts,
    acpWritesDuringExec: acpWrites,
    ok,
  });
  try {
    proc.kill();
  } catch {}
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
