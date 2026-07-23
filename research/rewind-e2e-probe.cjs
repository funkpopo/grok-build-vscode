// End-to-end: write via tools → snapshot → rewind → verify disk.
// Usage: node research/rewind-e2e-probe.cjs
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const GROK = path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwe2e-")));
fs.writeFileSync(path.join(cwd, "seed.txt"), "v1\n");

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let id = 1;
let buf = "";
const W = new Map();
let sessionId;
const acpWrites = [];
let lastPermOptions = null;

function send(m, p) {
  const i = id++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: m, params: p }) + "\n");
  return new Promise((r, j) => {
    const t = setTimeout(() => {
      W.delete(i);
      j(new Error("timeout " + m));
    }, 300000);
    W.set(i, (msg) => {
      clearTimeout(t);
      r(msg);
    });
  });
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
    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        const opts = msg.params?.options || msg.params?.permissionOptions || [];
        lastPermOptions = opts;
        // Prefer allow-always / allow_always / always, else first allow-ish, else first option
        const ids = opts.map((o) => o.optionId || o.id || o).filter(Boolean);
        console.log("PERM options", JSON.stringify(ids));
        let pick =
          ids.find((x) => /always|allow-always|allow_always|yolo/i.test(String(x))) ||
          ids.find((x) => /allow|once|approve|yes/i.test(String(x))) ||
          ids[0] ||
          "allow-once";
        console.log("PERM pick", pick);
        resp(msg.id, { outcome: { outcome: "selected", optionId: pick } });
      } else if (msg.method === "fs/read_text_file") {
        // Match the extension: missing files must ERROR so the CLI can snapshot
        // content:null (did-not-exist) instead of content:"" (empty file).
        try {
          if (!fs.existsSync(msg.params.path)) {
            proc.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32000, message: `ENOENT: ${msg.params.path}` },
              }) + "\n",
            );
          } else {
            resp(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
          }
        } catch (e) {
          proc.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32000, message: String(e.message || e) },
            }) + "\n",
          );
        }
      } else if (msg.method === "fs/write_text_file") {
        console.log(
          "ACP WRITE",
          msg.params.path,
          "contentNull=",
          msg.params.content == null,
          "len=",
          msg.params.content == null ? null : String(msg.params.content).length,
        );
        acpWrites.push({
          path: msg.params.path,
          contentNull: msg.params.content == null,
          len: msg.params.content == null ? null : String(msg.params.content).length,
        });
        fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
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
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "tool_call_update" && u.status === "failed") {
        console.log("TOOL FAILED", JSON.stringify(u.content || u).slice(0, 300));
      }
      if (u?.sessionUpdate === "tool_call_update" && u.status === "completed") {
        console.log("TOOL OK", u.title || u.toolCallId);
      }
    }
  }
});
proc.stderr.on("data", (d) => {
  const s = d.toString();
  if (/error|fail|rewind|permission/i.test(s)) process.stderr.write(s);
});

function state(l) {
  console.log(
    l,
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
  const rp = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    sessionId,
    "rewind_points.jsonl",
  );
  if (!fs.existsSync(rp)) return console.log("no rp");
  for (const line of fs.readFileSync(rp, "utf8").trim().split(/\n+/)) {
    const j = JSON.parse(line);
    const slim = (s) =>
      Object.fromEntries(
        Object.entries(s || {}).map(([k, v]) => [k, v.content == null ? "NULL" : `len${String(v.content).length}`]),
      );
    console.log("RP#" + j.prompt_index, slim(j.file_snapshots), "→", slim(j.after_snapshots));
  }
}

(async () => {
  console.log("cwd", cwd);
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "rwe2e", version: "0" },
  });
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;

  // Baseline
  let r = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: ok. No tools." }],
  });
  console.log("t0", r.result?.stopReason || r.error);
  state("after0");

  // Mutate
  r = await send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "Create created.txt with content NEWFILE. Overwrite seed.txt with content V2. Use Write tools. Then reply: done",
      },
    ],
  });
  console.log("t1", r.result?.stopReason || r.error, "writes", acpWrites.length);
  state("after1");
  dumpRp();

  if (!fs.existsSync(path.join(cwd, "created.txt"))) {
    console.log("ABORT: model did not create file. lastPerm", JSON.stringify(lastPermOptions));
    try {
      proc.kill();
    } catch {}
    process.exit(3);
  }

  // Rewind to baseline
  const exec = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 0,
    mode: "all",
    force: true,
  });
  console.log("EXEC", JSON.stringify(exec.result || exec.error, null, 2));
  state("after-rewind");

  const seedOk = fs.readFileSync(path.join(cwd, "seed.txt"), "utf8") === "v1\n";
  const createdGone = !fs.existsSync(path.join(cwd, "created.txt"));
  console.log("VERDICT", {
    seedOk,
    createdGone,
    reverted: exec.result?.reverted_files,
    clean: exec.result?.clean_files,
    conflicts: exec.result?.conflicts,
    pass: seedOk && createdGone,
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
