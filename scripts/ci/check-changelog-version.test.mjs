import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-changelog-version.mjs", import.meta.url));
const releaseScript = fileURLToPath(new URL("../check-release-version.mjs", import.meta.url));
function check({ gateway = "0.3.12", app = "0.3.11", protocol = "4.16.0", declared = true, tag,
  unreleased = true, protocolMarker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "alaya-changelog-"));
  try {
    const pkg = (path, name, version) => { mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, "package.json"), JSON.stringify({ name, version })); };
    pkg(".", "do-soul-alaya", app); pkg("packages/protocol", "@do-soul/alaya-protocol", protocol);
    pkg("packages/engine-gateway", "@do-soul/alaya-engine-gateway", gateway);
    const declarations = (protocolMarker ? "protocol 4.16.0\n" : "") +
      (declared ? "`@do-soul/alaya-engine-gateway` is\n`0.3.12` for the MCP tool surface.\n" : "");
    writeFileSync(join(root, "CHANGELOG.md"), unreleased
      ? "## Unreleased\nDo not tag `Unreleased`.\n" + declarations + "## v0.3.11\nPublished app.\n"
      : "## v0.3.11\n" + declarations + "Published app.\n");
    return spawnSync(process.execPath, tag === undefined ? [script] : [releaseScript, tag], { cwd: root, encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("independent MCP packages match their explicit unreleased declarations", () => assert.equal(check().status, 0));
test("an undeclared gateway version drift still fails", () => assert.equal(check({ declared: false }).status, 1));
test("declared protocol or gateway version mismatch still fails", () => {
  assert.equal(check({ gateway: "0.3.13" }).status, 1); assert.equal(check({ protocol: "4.17.0" }).status, 1);
});
test("an app package may not borrow the gateway exception", () => assert.equal(check({ app: "0.3.12" }).status, 1));
test("release validation uses the same independent package declarations", () => {
  assert.equal(check({ tag: "v0.3.11" }).status, 0);
  assert.equal(check({ tag: "v0.3.11", gateway: "0.3.13" }).status, 1);
  assert.equal(check({ tag: "v0.3.12" }).status, 1);
  assert.equal(check({ tag: "Unreleased" }).status, 1);
});
test("published declarations retain Protocol semver and changelog requirements without Unreleased", () => {
  assert.equal(check({ tag: "v0.3.11", unreleased: false }).status, 0);
  assert.equal(check({ tag: "v0.3.11", unreleased: false, protocolMarker: false }).status, 1);
  assert.equal(check({ tag: "v0.3.11", unreleased: false, protocolMarker: false, protocol: "invalid" }).status, 1);
  assert.equal(check({ tag: "v0.3.11", unreleased: false, gateway: "0.3.13" }).status, 1);
});
