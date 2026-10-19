import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const guard = new URL("./source-import-boundary.mjs", import.meta.url).href;
function run(program: string) {
  return spawnSync(process.execPath, ["--import", guard, "--input-type=module", "--eval", program], {
    env: { PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
    encoding: "utf8", timeout: 30_000
  });
}

it("loads installed SQLite and Jieba pins through named and native namespaced paths", () => {
  const result = run(`import assert from 'node:assert/strict'; import path from 'node:path';
    const { receipt } = await import(${JSON.stringify(guard)});
    const pins = receipt().native_pins;
    assert(pins.length >= 2);
    assert(pins.some(pin => /jieba/u.test(pin)));
    for (const pin of pins) {
      for (const filename of [pin, path.toNamespacedPath(pin)]) {
        const module = { exports: {} };
        process.dlopen(module, filename);
        assert(Object.keys(module.exports).length > 0);
      }
    }
    const evidence = receipt();
    assert.equal(evidence.operations.filter(row => row.operation === 'native-addon.load.allowed').length, pins.length * 2);
    assert.equal(evidence.operations.some(row => row.blocked), false);
    assert.equal(evidence.credential_file_violations.length, 0);
    console.log('NATIVE_PIN_LOADS=' + pins.length * 2);`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("NATIVE_PIN_LOADS=");
});

it("rejects an external copy of an installed addon before native loading", () => {
  const root = mkdtempSync(join(tmpdir(), "external-addon-"));
  try {
    const result = run(`import fs from 'node:fs';
      const { receipt } = await import(${JSON.stringify(guard)});
      const external = ${JSON.stringify(join(root, "external.node"))};
      fs.copyFileSync(receipt().native_pins[0], external);
      process.dlopen({ exports: {} }, external);`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Source import fixture refused native-addon.load");
    expect(result.stderr).not.toContain('"operation":"native-addon.load.allowed"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
