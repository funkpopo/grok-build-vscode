const fs = require("fs");
const path = require("path");

const base =
  process.argv[2] ||
  path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".grok",
    "sessions",
    "D%3A%5CProjects%5Cgrok-build-vscode",
  );
const id = process.argv[3];
const dirs = id
  ? [path.join(base, id)]
  : fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, 5);

for (const dir of dirs) {
  const rp = path.join(dir, "rewind_points.jsonl");
  console.log("\n===" + path.basename(dir) + " mtime=" + fs.statSync(dir).mtime.toISOString());
  if (!fs.existsSync(rp)) {
    console.log("(no rewind_points.jsonl)");
    continue;
  }
  const lines = fs.readFileSync(rp, "utf8").trim().split(/\n+/).filter(Boolean);
  console.log("lines", lines.length);
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      const slim = {
        prompt_index: j.prompt_index,
        has_file_changes: j.has_file_changes,
        num_file_snapshots: j.num_file_snapshots,
        preview: String(j.prompt_preview || "")
          .replace(/\s+/g, " ")
          .slice(0, 140),
        topKeys: Object.keys(j),
      };
      for (const k of Object.keys(j)) {
        if (/snapshot/i.test(k) && j[k] && typeof j[k] === "object") {
          slim[k] = Object.fromEntries(
            Object.entries(j[k]).map(([fk, v]) => {
              const content = v && typeof v === "object" ? v.content : undefined;
              return [
                fk,
                {
                  path: v && v.path,
                  len: content == null ? null : String(content).length,
                  preview: content == null ? null : String(content).slice(0, 60),
                  keys: v && typeof v === "object" ? Object.keys(v) : [],
                  deleted: v && v.deleted,
                },
              ];
            }),
          );
        }
      }
      console.log(JSON.stringify(slim, null, 2));
    } catch (e) {
      console.log("parse err", e.message, line.slice(0, 120));
    }
  }
}
