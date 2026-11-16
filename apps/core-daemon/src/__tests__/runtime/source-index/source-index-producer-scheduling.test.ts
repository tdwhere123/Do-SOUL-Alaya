import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const url = new URL("../../../../../../packages/core/src/__tests__/embedding-recall/authored-source-embedding-guard.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)).isolation;
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { SourceIndexLifecycle } from "@do-soul/alaya-core";
import { hashContentDigest, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { configuration, fieldSha256, fixture, publishSource, WORKSPACE, type Fixture } from
  "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { SourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

const environments: Fixture[] = [], producers: SourceIndexProducer[] = [];
afterEach(async () => {
  for (const producer of producers.splice(0)) await producer.stop();
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
});

it.each([2, 5])("wraps the workspace ring once without revisits under a %i-workspace pass cap", async maxWorkspacesPerPass => {
  const h = fixture(); environments.push(h);
  seedWorkspaces(h.database, ["workspace-3"]);
  for (const workspace_id of [WORKSPACE, "workspace-2", "workspace-3"]) {
    publishSource(h, `needle ${workspace_id}`, "source", { workspace_id });
    h.index.lexical.selectLexical(workspace_id, "raw-unicode61.v1");
  }
  const bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "fixture_no_model" }));
  const producer = new SourceIndexProducer({ database: h.database, bindSourceEmbedding: bind,
    warn: vi.fn(), limits: { maxWorkspacesPerPass } }); producers.push(producer);
  const lexical = vi.spyOn(SourceIndexLifecycle.prototype, "prepareLexical");
  const reclaim = vi.spyOn(SqliteSourceIndexRepository.prototype, "reclaimVectorPage");
  const visits: string[][] = [];
  for (let pass = 0; pass < 3; pass++) {
    lexical.mockClear(); reclaim.mockClear();
    expect(await producer.runPass()).toMatchObject({ status: "unsupported", reason: "fixture_no_model" });
    visits.push(lexical.mock.calls.map(call => call[0]));
    expect(reclaim.mock.calls.map(call => call[0])).toEqual(visits[pass]);
  }
  expect(visits).toEqual(maxWorkspacesPerPass === 2
    ? [["workspace-1", "workspace-2"], ["workspace-3", "workspace-1"], ["workspace-2", "workspace-3"]]
    : [["workspace-1", "workspace-2", "workspace-3"], ["workspace-1", "workspace-2", "workspace-3"],
      ["workspace-1", "workspace-2", "workspace-3"]]);
  expect(bind).toHaveBeenCalledTimes(3);
  for (const workspace of [WORKSPACE, "workspace-2", "workspace-3"]) {
    expect(h.index.lexical.lexicalState(workspace)?.active_generation_id).not.toBeNull();
    expect(h.index.state(workspace)).toEqual({ status: "unknown" });
  }
});

it("advances the ring before a workspace exhausts the single root and census slots, alternating lanes on wrap", async () => {
  const h = fixture(); environments.push(h);
  for (const workspace_id of [WORKSPACE, "workspace-2"]) {
    publishSource(h, "pin", "source", { workspace_id });
    h.index.lexical.selectLexical(workspace_id, "raw-unicode61.v1");
  }
  const events: string[] = [];
  const prepare = SourceIndexLifecycle.prototype.prepareLexical;
  vi.spyOn(SourceIndexLifecycle.prototype, "prepareLexical").mockImplementation(function (this: SourceIndexLifecycle, ...args) {
    events.push(`lexical:${args[0]}`);
    return prepare.apply(this, args);
  });
  const capture = SourceIndexLifecycle.prototype.capture;
  vi.spyOn(SourceIndexLifecycle.prototype, "capture").mockImplementation(function (this: SourceIndexLifecycle, ...args) {
    events.push(`vector:${args[0]}`);
    return capture.apply(this, args);
  });
  const producer = new SourceIndexProducer({ database: h.database, warn: vi.fn(),
    limits: { maxWorkspacesPerPass: 1, maxRootsPerPass: 1, maxCapturePages: 1, modelInputs: 1 }, bindSourceEmbedding: async options => {
      events.push("bind");
      const profile = configuration({ max_input_tokens: 12, window_bytes: options.window_bytes }).profile;
      return { status: "ready", profile, profile_id: sourceIndexProfileId(profile, fieldSha256),
        embedInputs: async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
          input_digest: hashContentDigest(input.text, fieldSha256), vector: new Float32Array([0.6, 0.8, 0]),
          token_count: 2, truncated: false })) };
    } }); producers.push(producer);
  const passes: string[][] = [];
  for (let pass = 0; pass < 4; pass++) {
    events.length = 0;
    const receipt = await producer.runPass();
    expect(receipt).toMatchObject({ visited_roots: 1, capture_pages: 1 });
    passes.push([...events]);
  }
  // First traversal gives lexical its single slot; the next wrap gives it to vectors.
  expect(passes).toEqual([["bind", "lexical:workspace-1"], ["bind", "lexical:workspace-2"],
    ["bind", "vector:workspace-1"], ["bind", "vector:workspace-2"]]);
  for (const workspace of [WORKSPACE, "workspace-2"]) {
    expect(h.index.lexical.lexicalState(workspace)?.active_generation_id).not.toBeNull();
    expect(h.index.state(workspace)).toMatchObject({ status: "ready" });
  }
});
