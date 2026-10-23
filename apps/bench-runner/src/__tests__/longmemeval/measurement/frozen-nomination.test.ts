import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const guards = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return [installProviderFreeBoundary(), installStrictProviderFreeBoundary()] as const;
});
import { SourceIndexAcquisition } from "@do-soul/alaya-core";
import { sourceIndexConfigurationId, sourceIndexGenerationId, sourceIndexProfileId, sourceIndexTarget } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { ConditionalNavigationRunSchema } from "../../../runs/source-access-diagnostic/conditional-navigation-input.js";
import { admitFrozenNominations } from "../../../runs/source-access-diagnostic/conditional-navigation-frozen.js";
import { runConditionalNavigation } from "../../../runs/source-access-diagnostic/conditional-navigation-run.js";
const helperPath = fileURLToPath(new URL("../../support/frozen-nomination-fixture.mjs", import.meta.url));
const helper = await import(helperPath);
let root: string, fixture: ReturnType<typeof helper.frozenFixture>;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "frozen-admission-")); fixture = helper.frozenFixture(join(root, "native")); });
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  expect(guards[0].violations).toEqual([]); expect(guards[1].forbidden).toEqual([]);
  guards[1].restore(); guards[0].restore();
});
const parsed = (value: unknown) => ConditionalNavigationRunSchema.parse(value);

it("captures caller configuration and every full artifact before asynchronous delivery waits", async () => {
  const config = helper.freezeFixture(join(root, "origin-mutation"), fixture);
  config.frozen_nominations.comparison = "source-context";
  const prepare = vi.spyOn(SourceIndexAcquisition, "prepareQuery").mockImplementation(() => { throw new Error("query preparation forbidden"); });
  const acquire = vi.spyOn(SourceIndexAcquisition.prototype, "captureNative").mockImplementation(() => { throw new Error("new acquisition forbidden"); });
  try {
    const pending = runConditionalNavigation(config, join(root, "mutation-output"));
    config.rows[7].authorized_scopes = []; config.rows[7].conditions[0].query = "mutated after call";
    config.frozen_nominations.comparison = "native-anchor";
    writeFileSync(join(root, "origin-mutation", "008.json"), "mutated after admission");
    const receipt = await pending;
    expect(receipt.status).toBe("complete"); expect(receipt.rows).toHaveLength(16);
    const frozenInput = JSON.parse(readFileSync(join(root, "mutation-output", "input.json"), "utf8"));
    expect(frozenInput.frozen_nominations.comparison).toBe("source-context");
    expect(receipt.rows.filter(row => row.arm === "window-source-context")).toHaveLength(8);
    expect(frozenInput.rows[7].authorized_scopes).toEqual(["project"]);
    expect(frozenInput.rows[7].conditions[0].query).toBe("needle");
    expect(prepare).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); acquire.mockRestore(); }
});

it("refuses a coherently rebound but foreign prepared profile at the current SQLite admission", async () => {
  const config = helper.freezeFixture(join(root, "origin-profile"), fixture, (input: typeof fixture.input, queries: typeof fixture.queries[]) => {
    input.rows.forEach((row: typeof input.rows[number], i: number) => {
      const binding = row.expected_index; binding.configuration.revision = "foreign-prepared-selection";
      binding.config_id = sourceIndexConfigurationId(binding.configuration, fieldContractSha256);
      binding.profile_id = sourceIndexProfileId(binding.configuration.profile, fieldContractSha256);
      binding.generation_id = sourceIndexGenerationId({ ...binding, workspace_id: row.workspace }, binding.source_epoch, fieldContractSha256);
      const query = queries[i][0];
      query.preparation.selected.config_id = binding.config_id;
      query.phase.result.vector.state.binding.config_id = binding.config_id;
      query.phase.result.vector.state.binding.generation_id = binding.generation_id;
    });
  });
  expect(admitFrozenNominations(parsed(config))).toBeDefined();
  const receipt = await runConditionalNavigation(config, join(root, "foreign-prepared-output"));
  expect(receipt.status).toBe("stopped"); expect(receipt.failure).toMatch(/prepared active generation unavailable|prepared profile/);
  expect(receipt.local_inference_inputs).toBe(0); expect(receipt.acquisitions).toBe(0);
});

it("refuses a foreign nomination workspace before any snapshot opens", () => {
  const config = helper.freezeFixture(join(root, "origin-workspace"), fixture);
  const path = join(root, "origin-workspace", "001.json"), capture = helper.json(path);
  // The canonical identity authority, not a made-up root-key codec.
  for (const hit of capture.captures[0].witness) {
    const source = hit.source;
    hit.source = sourceIndexTarget({ ...source.target, workspace_id: "foreign" }, source.source_id, source.body_bytes);
  }
  capture.captures[0].phase.result.occurrence_prefix = capture.captures[0].witness.slice(0, 16);
  helper.write(path, capture);
  const receiptPath = join(root, "origin-workspace", "receipt.json"), receipt = helper.json(receiptPath);
  receipt.rows[0].sha256 = helper.hash(readFileSync(path)); helper.write(receiptPath, receipt);
  config.frozen_nominations.receipt.sha256 = helper.hash(readFileSync(receiptPath));
  expect(() => admitFrozenNominations(parsed(config))).toThrow(/occurrence requires|frozen native occurrence/);
});

it("runs compiled startup, copied native SQLite hydration and frozen evaluation without model/query/acquisition entry", () => {
  const proof = fileURLToPath(new URL("../../support/frozen-nomination-proof.mjs", import.meta.url));
  const evidence = process.env.ALAYA_AUTHORED_FROZEN_EVIDENCE;
  const result = execFileSync(process.execPath, [proof, ...(evidence ? [evidence] : [])], { encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 ** 2 });
  expect(JSON.parse(result)).toMatchObject({ status: "complete" });
}, 250_000);
