import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const bootstrap = new URL("./field-delivery-proof-bootstrap.mjs", import.meta.url).href;

it.each(["composed-capture", "capture", "capture-second"])(
  "injects %s publication failure for either path separator without blocking other writes", fault => {
    const root = mkdtempSync(join(tmpdir(), "capture-fault-"));
    try {
      const leaf = fault === "capture-second" ? "002.json" : "001.json";
      const program = `import assert from 'node:assert/strict';
        import { writeFileSync, readFileSync } from 'node:fs';
        const paths = ${JSON.stringify([join(root, leaf), `/authored/captures/${leaf}`, `C:\\authored\\captures\\${leaf}`])};
        for (const path of paths) {
          assert.throws(() => writeFileSync(path, '{}'), /authored (?:composed )?capture publication failure/);
        }
        const allowed = ${JSON.stringify(join(root, fault === "capture-second" ? "001.json" : "002.json"))};
        writeFileSync(allowed, 'retained');
        assert.equal(readFileSync(allowed, 'utf8'), 'retained');
        console.log('CAPTURE_FAILURE_INJECTED');`;
      const result = spawnSync(process.execPath, ["--import", bootstrap, "--input-type=module", "--eval", program], {
        env: { PATH: process.env.PATH, ALAYA_AUTHORED_DELIVERY_FAULT: fault,
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
        encoding: "utf8", timeout: 30_000
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("CAPTURE_FAILURE_INJECTED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
);
