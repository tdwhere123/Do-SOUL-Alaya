import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const root of process.argv.slice(2)) {
  const lock = join(root, ".extraction-fill.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
    pid: process.pid,
    token: `sigkill-${process.pid}`,
    started_at: new Date().toISOString()
  })}\n`, "utf8");
}

process.stdout.write("LOCKS_READY\n");
setInterval(() => {}, 60_000);
