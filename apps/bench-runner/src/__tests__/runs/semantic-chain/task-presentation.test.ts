import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const guard = await vi.hoisted(async () => {
  const sourceGuard = "../../support/source-import-boundary.mjs";
  const source = await import(sourceGuard);
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  const strict = installStrictProviderFreeBoundary();
  // Explicit fixture-owned absent values only; never read ambient credential values.
  // The daemon may assign its own synthetic reviewer token during a native session.
  const controls = new Map<string, string | undefined>([
    "OPENAI_API_KEY", "ALAYA_OPENAI_SECRET_REF", "ALAYA_OFFICIAL_GARDEN_SECRET_REF", "ALAYA_GARDEN_OPENAI_SECRET_REF",
    "ALAYA_CONFLICT_LLM_API_KEY", "ALAYA_CONFLICT_LLM_SECRET_REF", "ALAYA_REQUEST_TOKEN", "ALAYA_REQUEST_TOKEN_WORKSPACES",
    "ALAYA_REVIEWER_TOKEN", "ALAYA_MCP_TOOL_CONFIRMATION_TOKEN", "ALAYA_E2E_EVENT_TRIGGER_TOKEN"
  ].map(key => [key, undefined]));
  const environment = process.env;
  process.env = new Proxy(environment, {
    get(target, key) { return typeof key === "string" && controls.has(key) ? controls.get(key) : Reflect.get(target, key); },
    set(target, key, value) {
      if (typeof key === "string" && controls.has(key)) controls.set(key, String(value));
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key) {
      if (typeof key === "string" && controls.has(key)) controls.set(key, undefined);
      return Reflect.deleteProperty(target, key);
    }
  });
  Object.assign(process.env, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx",
    ALAYA_SQLITE_WRITE_QUEUE: "0", ALAYA_CONFLICT_LLM_PROVIDER_URL: "", ALAYA_CONFLICT_LLM_MODEL: "", ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "false" });
  return { source, strict };
});

// Revision provenance is not under test here. Keep Git/process execution forbidden;
// only its implementation-revision observation is synthetic. Source seals and all
// physical request/price/reservation/cache/admission owners remain real.
vi.mock("../../../runs/extraction/authority/inspection.js", async original => ({
  ...await original<object>(), readCurrentExtractionAuthorityRevision: () => "a".repeat(40)
}));
// The cache writer's OS lock uses an eval worker listening on a local socket.
// Keep the no-network/no-unpinned-worker guard intact: only that lock primitive
// is a fixture port. Real filesystem containment, leases and ledger owners run.
const fixtureLocks = vi.hoisted(() => ({ active: 0 }));
vi.mock("../../../runs/extraction/fill/manifest/kernel-write-lease.js", () => ({
  acquireKernelWriteLease: () => {
    fixtureLocks.active++;
    let active = true;
    return { assertOwned: () => { if (!active) throw new Error("fixture lock released"); },
      release: () => { if (!active) throw new Error("fixture lock already released"); active = false; fixtureLocks.active--; } };
  },
  isKernelWriteLeaseActive: () => false
}));

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sourceSemanticInterpretationIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION } from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence, fieldContractSha256, projectSourceDisclosure } from "@do-soul/alaya-core";
import { proposeCorrespondenceSemantics, sourceSemanticCorrespondenceSystemPrompt, type SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitSourceQualifiedSelection, qualifiedSelectionInputPaths, type SourceQualifiedSelectionInput }
  from "../../../runs/semantic-chain/source-qualified-selection-input.js";
import { materializeSemanticProposalLines } from "../../../runs/semantic-proposal/workset.js";
import { projectCorrespondenceModelView, createCorrespondenceTaskPresentationContext } from "../../../runs/semantic-proposal/correspondence-model-view.js";
import { prepareSemanticProposal, readSemanticProposalResults, executeSemanticProposalFill } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { semanticProposalCacheInputPaths, semanticProposalLookup } from "../../../runs/semantic-proposal/attempt.js";
import { inspectSemanticProposalShard, semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { nativeSourceSnapshotManifestPath, readVerifiedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { createSourceRecordsSidecarWriter, inspectSourceRecordsArtifact, sealSourceRecordsManifest,
  sourceRecordsManifestPath, sourceRecordsSidecarPath, sourceRecordsArtifactInputPaths, type SourceRecordsMessage } from "../../../runs/snapshot/source-records/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { taskPresentationFixture, unknownTaskPresentationFixture, withResealedTaskOccurrences,
  taskPresentationOccurrencePins, withResealedTaskQuestionHeader, assessmentRaw, selectedLine, TOKENS, GENERATION } from "./task-presentation.test-support.js";
import { authoredProposal } from "./source-qualified-selection.test-support.js";

type Fixture = Awaited<ReturnType<typeof taskPresentationFixture>>;
let h: Fixture, unknown: Fixture, root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bench-task-presentation-"));
  h = await taskPresentationFixture(root);
  unknown = await unknownTaskPresentationFixture(h);
}, 120000);
beforeEach(() => {
  if (guard.strict.forbidden.length || guard.source.receipt().operations.some((row: { blocked?: boolean }) => row.blocked)) {
    throw new Error(`Unexpected live effect; fixture evidence preserved at ${root}`);
  }
});
afterAll(async () => {
  await settleActiveBenchDaemonTasks();
  const receipt = guard.source.receipt(), forbidden = [...guard.strict.forbidden];
  guard.strict.restore(); guard.source.restore();
  const blocked = receipt.operations.filter((row: { blocked?: boolean }) => row.blocked);
  if (blocked.length === 0 && forbidden.length === 0 && receipt.credential_file_violations.length === 0) rmSync(root, { recursive: true, force: true });
  expect(blocked).toEqual([]); expect(forbidden).toEqual([]); expect(receipt.credential_file_violations).toEqual([]);
  expect(fixtureLocks.active).toBe(0);
  process.stdout.write(`TASK_PRESENTATION_GUARD ${JSON.stringify({ blocked_operations: blocked.length, forbidden_credentials: forbidden.length,
    allowed_read_workers: receipt.operations.filter((row: { operation: string }) => row.operation === "worker.create.allowed").length })}\n`);
});

function request(line = selectedLine(h)) { return line.request as SourceSemanticCorrespondenceRequest; }
function changedItem(change: (item: Record<string, unknown>) => void) {
  const workset = structuredClone(h.cWorkset());
  change(workset.items[0] as Record<string, unknown>);
  return workset;
}

it("shows only selected verified outer roles and distinct occurrences without binding assistant authors", () => {
  const records = readVerifiedNativeSourceSnapshot(h.snapshot).records;
  const views = h.descriptors.map((_, i) => JSON.parse(selectedLine(h, i).userPrompt) as ReturnType<typeof projectCorrespondenceModelView>);
  for (const [i, view] of views.entries()) {
    const native = request(selectedLine(h, i)), presentation = view.task_presentation.original_outer_messages[0]!;
    const record = records.find(row => row.record.source_id === native.source_interpretation_descriptors[0]!.interpretation.source.source_id)!;
    expect(view.contract).toBe("bench-question-local-task-presentation-v1");
    expect(view.native_request).toEqual({ ...native, response_schema: selectedLine(h, i).responseJsonSchema });
    expect(presentation.original_outer_role).toBe(record.content_bytes.startsWith("Assistant:") ? "user" : "assistant");
    expect(presentation.source_record.record_id).toBe(record.record.identity);
    expect(native.source_interpretation_descriptors[0]!.interpretation.source).not.toHaveProperty("speaker");
    const attribution = native.source_interpretation_descriptors[0]!.interpretation.source.attribution_context;
    expect(attribution).toEqual(record.record.attribution_context);
    if (presentation.original_outer_role === "assistant") expect(attribution).toMatchObject({ status: "captured", utterances: [{ author_ref: null }] });
    const legacy = materializeSemanticProposalLines(h.cWorkset(i, false), TOKENS)[0]!;
    expect(legacy.userPrompt).toBe(JSON.stringify({ ...native, response_schema: legacy.responseJsonSchema }));
    expect(legacy.systemPrompt).toBe(sourceSemanticCorrespondenceSystemPrompt(native));
    expect(legacy.userPrompt).not.toContain("original_outer_role");
    expect(selectedLine(h, i).key).not.toBe(legacy.key);
    expect(selectedLine(h, i).requestDigest).not.toBe(legacy.requestDigest);
    expect(selectedLine(h, i).inputByteUpper).toBeGreaterThan(legacy.inputByteUpper);
  }
  const assistants = views.flatMap(view => view.task_presentation.original_outer_messages).filter(row => row.original_outer_role === "assistant");
  expect(assistants.map(row => row.occurrence.session_id).sort()).toEqual(["actual-a", "actual-b"]);
  expect(h.query.approved_fixed_context?.notes).not.toContain("amber");
  expect(h.query.approved_fixed_context?.notes).toContain("Equal role labels do not identify participants");
  expect(h.query.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
});

it("encodes the exact approved question clock in actual Q and C inputs, independently of source dates", () => {
  const artifact = inspectSourceRecordsArtifact(h.retained);
  const clock = "2026-09-18T00:00:00.000Z";
  expect(artifact.sidecar.questions).toEqual([{ question_id: h.selection.question_id, interpretation_clock: clock }]);
  expect(artifact.sidecar.recorded_at).toBe("2026-09-25T00:00:00.000Z");
  const messages: SourceRecordsMessage[] = [];
  inspectSourceRecordsArtifact(h.retained, row => messages.push(row));
  expect(new Set(messages.map(row => row.source_observed_at))).toEqual(new Set([
    "2026-09-16T00:00:00.000Z", "2026-09-17T00:00:00.000Z"]));
  const q = JSON.parse(h.q.result.line.userPrompt), view = JSON.parse(selectedLine(h).userPrompt);
  expect(q.approved_fixed_context.notes).toContain(`Interpretation clock: ${clock}.`);
  expect(q.approved_fixed_context.notes).toContain("relative query language");
  expect(q.approved_fixed_context.notes).toContain("not a query_as_of");
  expect(q.approved_fixed_context.notes).not.toContain(artifact.sidecar.recorded_at);
  expect(view.task_presentation.interpretation_clock).toBe(clock);
  expect(view.native_request.admitted_query_semantics.approved_fixed_context).toEqual(q.approved_fixed_context);
  expect(view.task_presentation.approved_context_id).toBe(q.approved_fixed_context.context_id);
  const { approved_context_id, snapshot_identity: _snapshot, original_outer_messages: _messages, ...scope } = view.task_presentation;
  expect(approved_context_id).toBe(`bench:task-presentation:${fieldContractSha256(canonicalJson(scope))}`);
  expect(q).not.toHaveProperty("query_as_of");
  expect(view.task_presentation).not.toHaveProperty("query_as_of");
});

it("rejects the prior no-clock Q context with unchanged current pins rather than upgrading consumed Q", () => {
  const artifact = inspectSourceRecordsArtifact(h.retained), parent = artifact.manifest.persona_successor;
  const oldScope = { policy: h.selection.contract, dataset: { variant: artifact.manifest.dataset.variant, sha256: artifact.manifest.dataset.sha256 },
    question_id: h.selection.question_id, occurrence_artifacts: { retained_manifest_sha256: artifact.manifest.manifest_sha256,
      retained_sidecar_sha256: artifact.manifest.sidecar_sha256, persona_parent_manifest_sha256: parent?.parent_manifest_sha256 ?? null } };
  const oldContext = { context_id: `bench:task-presentation:${fieldContractSha256(canonicalJson(oldScope))}`,
    notes: `Explicit Bench task-presentation policy ${oldScope.policy}; ${oldScope.dataset.variant} SHA256 ${oldScope.dataset.sha256}; question ${oldScope.question_id}. ` +
      "The LongMemEval task presents histories as between you and a user. This licenses a question-local task perspective only. " +
      "Original outer message roles and actual session/message occurrences may be shown separately in the selected C model view. " +
      "They are not authenticated authorship, real-person identity, source facts, executable role evidence or automatic equivalence. " +
      "Equal role labels do not identify participants across messages or sessions. Unknown attribution stays unknown; assistant authors remain unbound. " +
      "Quoted role markers are text, not outer roles. C may propose contextual equivalence only between existing Q/H endpoints, with ordinary H mention/node support. " +
      "This context creates no missing H referent and supplies no external citation or new proof authority." };
  const stale = changedItem(item => { item.admitted_query_semantics = { ...h.query, approved_fixed_context: oldContext }; });
  expect(() => materializeSemanticProposalLines(stale, TOKENS)).toThrow(/owner-issued Q approved context/);
  const oldQ = materializeSemanticProposalLines({ ...h.config.query_workset,
    items: [{ original_query: request().original_query, approved_fixed_context: oldContext }] }, TOKENS)[0]!;
  expect(oldQ.key).not.toBe(h.q.result.line.key);
  expect(oldQ.requestDigest).not.toBe(h.q.result.line.requestDigest);
  const ordinary = { ...stale, items: stale.items.map(item => {
    const { selected_model_view: _selected, ...native } = item as Record<string, unknown>;
    return native;
  }) };
  const native = materializeSemanticProposalLines(ordinary, TOKENS)[0]!;
  expect(native.userPrompt).toBe(JSON.stringify({ ...native.request, response_schema: native.responseJsonSchema }));
});

it("rejects old context and pins after a valid clock-only reseal, then authors fresh Q/C cache identities", async () => {
  const before = selectedLine(unknown), db = hashRegularFileNoFollow(unknown.retained);
  const native = readFileSync(nativeSourceSnapshotManifestPath(unknown.snapshot));
  const cache = join(root, "clock-change-cache"), workset = unknown.cWorkset();
  await authoredProposal(workset, cache, assessmentRaw);
  const shardPath = semanticProposalShardPath(cache, before.key), shard = readFileSync(shardPath);
  const clock = "2026-09-19T12:34:56.789Z";
  await withResealedTaskQuestionHeader(unknown.retained, header => {
    header.questions = [{ question_id: unknown.selection.question_id, interpretation_clock: clock }];
  }, async () => {
    expect(hashRegularFileNoFollow(unknown.retained)).toBe(db);
    expect(readFileSync(nativeSourceSnapshotManifestPath(unknown.snapshot))).toEqual(native);
    expect(() => selectedLine(unknown)).toThrow(/occurrence artifact/);
    expect(() => readSemanticProposalResults(workset, cache, TOKENS)).toThrow(/occurrence artifact/);
    const selection = { ...unknown.selection, ...taskPresentationOccurrencePins(unknown.retained) };
    const replacement = { ...workset, items: [{ ...workset.items[0] as object, selected_model_view: selection }] };
    expect(() => materializeSemanticProposalLines(replacement, TOKENS)).toThrow(/owner-issued Q approved context/);
    const context = createCorrespondenceTaskPresentationContext(selection);
    expect(context.notes).toContain(`Interpretation clock: ${clock}.`);
    expect(context.context_id).not.toBe(unknown.query.approved_fixed_context?.context_id);
    const qWorkset = { ...unknown.config.query_workset, items: [{ original_query: request(before).original_query, approved_fixed_context: context }] };
    const q = await authoredProposal(qWorkset, join(root, "changed-clock-q-cache"), () => unknown.q.result.shard!.raw_json);
    expect(q.result.line.key).not.toBe(unknown.q.result.line.key);
    expect(q.result.line.requestDigest).not.toBe(unknown.q.result.line.requestDigest);
    const admitted = q.result.received;
    if (admitted === undefined || !("query" in admitted) || admitted.query === undefined) throw new Error("fresh authored Q missing");
    const fresh = { ...replacement, items: [{ ...replacement.items[0] as object, admitted_query_semantics: admitted.query }] };
    const line = materializeSemanticProposalLines(fresh, TOKENS)[0]!, view = JSON.parse(line.userPrompt);
    expect(view.task_presentation.interpretation_clock).toBe(clock);
    expect(view.native_request.admitted_query_semantics.approved_fixed_context).toEqual(context);
    expect(line.key).not.toBe(before.key); expect(line.requestDigest).not.toBe(before.requestDigest);
    expect(readSemanticProposalResults(fresh, cache, TOKENS)[0]?.status).toBe("unattempted");
    expect(readFileSync(shardPath)).toEqual(shard);
  });
  expect(selectedLine(unknown).key).toBe(before.key);
  expect(readSemanticProposalResults(workset, cache, TOKENS)[0]?.status).toBe("interpreted");
});

it("fails closed on unavailable, invalid or mismatched question clocks under the existing retained header contract", async () => {
  const question_id = unknown.selection.question_id, interpretation_clock = "2026-09-18T00:00:00.000Z";
  for (const questions of [undefined, [], [{ question_id }], [{ question_id, interpretation_clock: null }],
    [{ question_id, interpretation_clock: "not-a-clock" }], [{ question_id: "foreign", interpretation_clock }],
    [{ question_id, interpretation_clock }, { question_id, interpretation_clock }]]) {
    await withResealedTaskQuestionHeader(unknown.retained, header => {
      if (questions === undefined) delete header.questions;
      else header.questions = questions;
    }, async () => {
      expect(() => inspectSourceRecordsArtifact(unknown.retained)).toThrow();
      expect(() => createCorrespondenceTaskPresentationContext(unknown.selection)).toThrow();
      expect(() => selectedLine(unknown)).toThrow();
    });
  }
});

it("preserves unknown source attribution rather than inferring an assistant from missing authors", () => {
  const parent = readVerifiedNativeSourceSnapshot(unknown.snapshot);
  for (const [index, descriptor] of unknown.descriptors.entries()) {
    const record = parent.records.find(member => member.source_id === descriptor.source_id)!.record;
    expect(record.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    const line = selectedLine(unknown, index), view = JSON.parse(line.userPrompt);
    expect(request(line).source_interpretation_descriptors[0]!.interpretation.source.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    expect(view.task_presentation.original_outer_messages[0].original_outer_role).toBe(record.speaker);
  }
});

for (const population of ["unknown", "persona"] as const) {
  it.each(["session_id", "session_index", "round_index", "message_index"] as const)(
    `rejects coordinate-only %s resealing under the unchanged ${population} selection`, async coordinate => {
      const fixture = population === "unknown" ? unknown : h;
      const db = hashRegularFileNoFollow(fixture.retained), native = readFileSync(nativeSourceSnapshotManifestPath(fixture.snapshot));
      const context = fixture.query.approved_fixed_context, line = selectedLine(fixture), workset = fixture.cWorkset();
      const cache = join(root, `${population}-${coordinate}-cache`), stage = join(root, `${population}-${coordinate}-prepare`);
      const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cache, TOKENS, 1),
        inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
      const produced = await authoredProposal(workset, cache, assessmentRaw);
      const shardPath = semanticProposalShardPath(cache, line.key), shard = readFileSync(shardPath);
      const member = readVerifiedNativeSourceSnapshot(fixture.snapshot).records.find(row => row.source_id === fixture.descriptors[0]!.source_id)!;
      const tuple = { source_id: member.source_id, source_version: member.source_version,
        record_id: member.record.identity, content_digest: member.record.content_digest };
      const qualified: SourceQualifiedSelectionInput = { contract: "private-qualified-source-selection-v1", query_as_of: null,
        snapshot_identity: fixture.manifest.identity, snapshot_source_count: 3, query: fixture.q.artifact,
        nominees: [{ nominee: tuple, current: tuple, body_bytes: Buffer.byteLength(member.content_bytes),
          interpretation: { ...fixture.descriptors[0]!, source_disclosure: projectSourceDisclosure({ material_kind: "interpretation",
            evaluated_as_of: fixture.config.interpretation_clock, source: member.record }) },
          correspondence: { workset, cache_root: cache, max_output_tokens: TOKENS, artifact: produced.artifact } }] };
      expect(admitSourceQualifiedSelection(fixture.config, qualified).status).toBe("ready");
      const extractor = { extract: vi.fn(async () => { throw new Error("must not dispatch"); }) };
      await withResealedTaskOccurrences(fixture.retained, rows => {
        const row = rows[0]!;
        if (coordinate === "session_id") row.session_id += "-replaced";
        else row[coordinate] += 100;
      }, async () => {
        expect(hashRegularFileNoFollow(fixture.retained)).toBe(db);
        expect(readFileSync(nativeSourceSnapshotManifestPath(fixture.snapshot))).toEqual(native);
        expect(fixture.query.approved_fixed_context).toEqual(context);
        expect(line.userPrompt).toContain('"original_outer_role"');
        const failure = /occurrence artifact|original message coordinates/;
        expect(() => selectedLine(fixture)).toThrow(failure);
        await expect(prepareSemanticChain(fixture.config, stage)).rejects.toThrow(failure);
        expect(existsSync(join(stage, "prepare.json"))).toBe(false);
        expect(existsSync(join(stage, "semantic_correspondence-workset.json"))).toBe(false);
        await expect(executeSemanticProposalFill({ workset, cacheRoot: cache, authority,
          config: { model: GENERATION.model, requestProfile: "gemini-3.1-minimal-v1", providerUrl: GENERATION.provider_url, apiKey: null }, extractor }))
          .rejects.toThrow(failure);
        expect(extractor.extract).not.toHaveBeenCalled();
        // The exact old interpreted cache is readmitted, not mistaken for a fresh key.
        expect(() => readSemanticProposalResults(workset, cache, TOKENS)).toThrow(failure);
        expect(() => admitSourceQualifiedSelection(fixture.config, qualified)).toThrow(failure);
        expect(readFileSync(shardPath)).toEqual(shard);
        const replacement = { ...fixture.selection, ...taskPresentationOccurrencePins(fixture.retained) };
        const replaced = { ...workset, items: [{ ...workset.items[0] as object, selected_model_view: replacement }] };
        expect(() => materializeSemanticProposalLines(replaced, TOKENS)).toThrow(population === "unknown"
          ? /owner-issued Q approved context/ : /original message coordinates/);
        if (population === "unknown") {
          expect(createCorrespondenceTaskPresentationContext(replacement).context_id).not.toBe(context?.context_id);
        }
        for (const path of sourceRecordsArtifactInputPaths(fixture.retained)) {
          expect(semanticProposalCacheInputPaths(workset, cache, TOKENS)).toContain(path);
          expect(qualifiedSelectionInputPaths(fixture.config, qualified)).toContain(path);
        }
      });
      expect(selectedLine(fixture).key).toBe(line.key);
      expect(readSemanticProposalResults(workset, cache, TOKENS)[0]?.status).toBe("interpreted");
    });
}


it("prepares actual native C workset wires, executes authored outputs and readmits them at the qualified input boundary", async () => {
  const plan = await prepareSemanticChain(h.config, join(root, "chain"));
  expect(plan.queries[0]?.status).toBe("ready"); expect(plan.correspondence_workset?.items).toHaveLength(3);
  const workset = plan.correspondence_workset!, discovered = plan.queries[0]!;
  if (discovered.status !== "ready") throw new Error("native Q discovery required");
  const produced = await authoredProposal(workset, h.config.correspondence_cache_root, assessmentRaw);
  const replay = readSemanticProposalResults(workset, h.config.correspondence_cache_root, TOKENS);
  expect(replay.map(row => row.status)).toEqual(["interpreted", "interpreted", "interpreted"]);
  expect(produced.result.line.userPrompt).toContain('"original_outer_role"');
  const records = readVerifiedNativeSourceSnapshot(h.snapshot).records;
  const input: SourceQualifiedSelectionInput = { contract: "private-qualified-source-selection-v1", query_as_of: null,
    snapshot_identity: h.manifest.identity, snapshot_source_count: 3, query: h.q.artifact,
    nominees: replay.map(row => {
      const descriptor = request(row.line).source_interpretation_descriptors[0]!;
      const member = records.find(member => member.record.source_id === descriptor.interpretation.source.source_id)!;
      const tuple = { source_id: member.source_id, source_version: member.source_version,
        record_id: member.record.identity, content_digest: member.record.content_digest };
      return { nominee: tuple, current: tuple, body_bytes: Buffer.byteLength(member.content_bytes),
        interpretation: discovered.descriptors.find(d => d.interpretation_id === descriptor.source_interpretation_id),
        correspondence: { workset: { ...workset, items: workset.items.filter((_item, index) => replay[index]!.line.key === row.line.key) },
          cache_root: h.config.correspondence_cache_root, max_output_tokens: TOKENS,
          artifact: { key: row.line.key, cache_identity: fieldContractSha256(canonicalJson(row.shard)),
            historical_production: { status: "reported", usage: row.shard!.usage } } } };
    }) };
  const admitted = admitSourceQualifiedSelection(h.config, input);
  expect(admitted.status).toBe("ready"); expect(admitted.new_dispatches).toBe(0);
  expect(admitted.population.nominees.map(row => row.correspondence_status)).toEqual(["interpreted", "interpreted", "interpreted"]);
  const paths = qualifiedSelectionInputPaths(h.config, input);
  expect(paths).toContain(nativeSourceSnapshotManifestPath(h.snapshot));
  for (const path of [...sourceRecordsArtifactInputPaths(h.retained), ...sourceRecordsArtifactInputPaths(h.parent)]) expect(paths).toContain(path);
  const { correspondence_model_view: _view, ...changed } = structuredClone(h.config);
  expect(() => admitSourceQualifiedSelection(changed, input)).toThrow(/explicit chain selection/);
  const foreign = { ...h.config, snapshot_path: join(root, "native.sqlite") };
  expect(() => admitSourceQualifiedSelection(foreign, input)).toThrow(/snapshot identity changed/);
  expect(await prepareSemanticChain(h.config, join(root, "chain"))).toEqual(plan);
}, 120000);

it("refuses an unapproved Q before publishing C workset items and closes the native read session", async () => {
  const cache = join(root, "unapproved-q-cache"), stage = join(root, "unapproved-stage");
  const workset = { ...h.config.query_workset, items: [{ original_query: h.query.original_query_digest ? request().original_query : "" }] };
  await authoredProposal(workset, cache, () => h.q.result.shard!.raw_json);
  await expect(prepareSemanticChain({ ...h.config, query_workset: workset, query_cache_root: cache }, stage))
    .rejects.toThrow(/owner-issued Q approved context/);
  expect(existsSync(join(stage, "prepare.json"))).toBe(false);
  expect(existsSync(join(stage, "semantic_correspondence-workset.json"))).toBe(false);
  expect(readdirSync(stage).filter(name => name.startsWith("native-session-"))).toEqual([]);
  expect(hashRegularFileNoFollow(h.snapshot)).toBe(h.manifest.db_sha256);
}, 120000);

it("does not reuse legacy authority/cache and rejects projection tampering under the original identity", async () => {
  const legacy = h.cWorkset(0, false), selected = h.cWorkset(), cache = join(root, "legacy-cache");
  const old = await authoredProposal(legacy, cache, assessmentRaw);
  const line = selectedLine(h);
  expect(readSemanticProposalResults(selected, cache, TOKENS)[0]!.status).toBe("unattempted");
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(legacy, cache, TOKENS, 1), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  const extractor = { extract: vi.fn(async () => { throw new Error("must not dispatch"); }) };
  await expect(executeSemanticProposalFill({ workset: selected, cacheRoot: cache, authority,
    config: { model: GENERATION.model, requestProfile: "gemini-3.1-minimal-v1", providerUrl: GENERATION.provider_url, apiKey: null }, extractor }))
    .resolves.toMatchObject({ attempts: 0, interpreted: 0, unattempted: 1 });
  const selectedPreflight = prepareSemanticProposal(selected, cache, TOKENS, 1);
  expect(selectedPreflight.keys).toEqual([line.key]);
  expect(selectedPreflight.maximum_input_tokens_per_attempt).toBe(line.inputByteUpper);
  expect(extractor.extract).not.toHaveBeenCalled();
  const forged = structuredClone(old.result.shard!);
  forged.user_prompt = line.userPrompt;
  writeFileSync(semanticProposalShardPath(cache, old.result.line.key), JSON.stringify(forged));
  expect(() => inspectSemanticProposalShard(cache, old.result.line.key, semanticProposalLookup(legacy, old.result.line, TOKENS))).toThrow(/identity mismatch/);
  const selectedCache = join(root, "tampered-view-cache"), produced = await authoredProposal(selected, selectedCache, assessmentRaw);
  const projectionLie = structuredClone(produced.result.shard!), wire = JSON.parse(projectionLie.user_prompt);
  wire.task_presentation.original_outer_messages[0].original_outer_role = "system";
  projectionLie.user_prompt = JSON.stringify(wire);
  writeFileSync(semanticProposalShardPath(selectedCache, line.key), JSON.stringify(projectionLie));
  expect(() => readSemanticProposalResults(selected, selectedCache, TOKENS)).toThrow(/identity mismatch/);
  const paths = semanticProposalCacheInputPaths(selected, cache, TOKENS);
  expect(paths).toContain(h.snapshot); expect(paths).toContain(h.retained);
  expect(() => materializeSemanticProposalLines(changedItem(item => {
    item.selected_model_view = { ...h.selection, original_outer_role: "user", issued: true };
  }), TOKENS)).toThrow();
});

it("keeps the ordinary C endpoint/support/context admission rules inside the selected envelope", () => {
  const native = request(), raw = JSON.parse(assessmentRaw(selectedLine(h).userPrompt));
  const receive = (body: unknown) => proposeCorrespondenceSemantics({ original_query: native.original_query,
    admitted_query_semantics: native.admitted_query_semantics, source_interpretation_descriptors: native.source_interpretation_descriptors,
    ...native.producer_capability }, { rawJson: JSON.stringify(body) });
  expect(receive(raw).outcome.status).toBe("interpreted");
  for (const change of [
    (pair: Record<string, unknown>) => { pair.source = "se999"; },
    (pair: Record<string, unknown>) => { pair.source_semantic_support = [{ kind: "external_role", role: "assistant" }]; },
    (pair: Record<string, unknown>) => { pair.source_semantic_support = [{ kind: "lexical", mentions: ["original_outer_role"] }]; },
    (pair: Record<string, unknown>) => { pair.applicable_context = "assistant"; }
  ]) {
    const changed = structuredClone(raw);
    const supported = changed.semantic_correspondence.assessments.find((row: { status: string }) => row.status === "supported");
    change(supported.equivalents[0]);
    const received = receive(changed);
    expect(admitSourceSemanticCorrespondence({ semantic_correspondence: received.semantic_correspondence,
      source_interpretation: native.source_interpretation_descriptors[0]!.interpretation,
      query_semantics: native.admitted_query_semantics, original_query: native.original_query }).kind).not.toBe("admitted");
  }
  expect(native.source_interpretation_descriptors[0]!.interpretation.referents.length).toBeGreaterThan(0);
});

it("requires its exact approved Q context and rejects foreign scopes and missing/version-changed H joins", () => {
  for (const selection of [{ ...h.selection, question_id: "foreign-question" }, { ...h.selection, snapshot_identity: "0".repeat(64) }]) {
    expect(() => createCorrespondenceTaskPresentationContext(selection)).toThrow();
  }
  expect(() => materializeSemanticProposalLines(changedItem(item => {
    const query = structuredClone(item.admitted_query_semantics) as typeof h.query;
    item.admitted_query_semantics = { ...query, approved_fixed_context: { ...query.approved_fixed_context!, context_id: "not-owner-issued" } };
  }), TOKENS)).toThrow(/owner-issued Q approved context/);
  for (const update of [{ source_id: "absent-original" }, { source_version: "different-version" }, { content_digest: `sha256:${"a".repeat(64)}` },
    { attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION }]) {
    expect(() => materializeSemanticProposalLines(changedItem(item => {
      const descriptors = item.source_interpretation_descriptors as SourceSemanticCorrespondenceRequest["source_interpretation_descriptors"];
      const interpretation = { ...descriptors[0]!.interpretation, source: { ...descriptors[0]!.interpretation.source, ...update } };
      item.source_interpretation_descriptors = [{ interpretation,
        source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256) }];
    }), TOKENS)).toThrow(/join|attribution/);
  }
  const line = selectedLine(h), native = request(line);
  expect(() => projectCorrespondenceModelView({ selection: h.selection,
    request: { ...native, endpoint_evidence: { ...native.endpoint_evidence, contract: "forged" } } as unknown as SourceSemanticCorrespondenceRequest })).toThrow();
});

it("rejects a changed seal or a self-resealed speaker/version lie against the real SQLite", () => {
  const path = nativeSourceSnapshotManifestPath(h.snapshot), bytes = readFileSync(path);
  try {
    const manifest = JSON.parse(bytes.toString("utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, identity: "0".repeat(64) }));
    expect(() => selectedLine(h)).toThrow(/seal changed/);
    for (const update of [{ speaker: "system" }, { source_version: "forged-version" }]) {
      const changed = structuredClone(manifest);
      Object.assign(changed.sources[0].record, update);
      const { identity: _identity, ...body } = changed;
      changed.identity = fieldContractSha256(JSON.stringify(body));
      writeFileSync(path, JSON.stringify(changed));
      expect(() => materializeSemanticProposalLines(changedItem(item => { item.selected_model_view = { ...h.selection, snapshot_identity: changed.identity }; }), TOKENS))
        .toThrow(/record differs/);
    }
  } finally { writeFileSync(path, bytes); }
});

it("checks explicit persona parent absence and every retained occurrence pin", () => {
  for (const selection of [
    { ...h.selection, retained_manifest_sha256: "0".repeat(64) },
    { ...h.selection, retained_sidecar_sha256: "0".repeat(64) },
    { ...h.selection, persona_parent: { ...h.selection.persona_parent!, manifest_sha256: "0".repeat(64) } },
    { ...h.selection, persona_parent: null }
  ]) expect(() => createCorrespondenceTaskPresentationContext(selection)).toThrow(/occurrence artifact/);
  const { persona_parent: _parent, ...omitted } = unknown.selection;
  expect(() => createCorrespondenceTaskPresentationContext(omitted)).toThrow(/persona_parent/);
  expect(() => createCorrespondenceTaskPresentationContext({ ...unknown.selection, persona_parent: h.selection.persona_parent }))
    .toThrow(/verified parent artifact/);
  expect(JSON.parse(selectedLine(unknown).userPrompt).task_presentation.occurrence_artifacts).toEqual({
    retained_manifest_sha256: unknown.selection.retained_manifest_sha256,
    retained_sidecar_sha256: unknown.selection.retained_sidecar_sha256, persona_parent_manifest_sha256: null });
});

it("rejects a coordinate-only changed persona parent and inventories both parent references before admission", async () => {
  const workset = h.cWorkset(), before = selectedLine(h).key;
  await withResealedTaskOccurrences(h.parent, rows => { rows[0]!.round_index += 100; }, async () => {
    expect(() => selectedLine(h)).toThrow(/verified parent artifact/);
    expect(() => createCorrespondenceTaskPresentationContext({ ...h.selection,
      persona_parent: { snapshot_path: h.parent, manifest_sha256: taskPresentationOccurrencePins(h.parent).retained_manifest_sha256 } }))
      .toThrow(/verified parent artifact/);
    const paths = semanticProposalCacheInputPaths(workset, join(root, "parent-unread-cache"), TOKENS);
    for (const path of sourceRecordsArtifactInputPaths(h.parent)) expect(paths).toContain(path);
    // Even a malformed selection must inventory the independently readable origin parent.
    const malformed = { ...workset, items: [{ ...workset.items[0] as object, selected_model_view: { ...h.selection,
      persona_parent: { snapshot_path: join(root, "unadmitted-parent"), manifest_sha256: "not-a-digest" } } }] };
    const retainedPaths = semanticProposalCacheInputPaths(malformed, join(root, "malformed-cache"), TOKENS);
    for (const path of [...sourceRecordsArtifactInputPaths(h.parent), ...sourceRecordsArtifactInputPaths(join(root, "unadmitted-parent"))]) {
      expect(retainedPaths).toContain(path);
    }
  });
  expect(selectedLine(h).key).toBe(before);
});

it("fails closed on missing/ambiguous retained occurrence membership, while inventories retain the references", () => {
  const messages: SourceRecordsMessage[] = [], artifact = inspectSourceRecordsArtifact(h.retained, row => messages.push(row));
  const indexPath = sourceRecordsSidecarPath(h.retained), manifestPath = sourceRecordsManifestPath(h.retained);
  const index = readFileSync(indexPath), manifest = readFileSync(manifestPath);
  const { shards: _shards, message_count: _count, ...header } = artifact.sidecar;
  try {
    for (const rows of [messages.slice(1), [...messages, { ...messages[0]!, message_index: 100 }]]) {
      const writer = createSourceRecordsSidecarWriter(h.retained, header);
      for (const row of rows) writer.append(row);
      const sidecar = writer.finish();
      const { manifest_sha256: _old, ...body } = artifact.manifest;
      writeFileSync(manifestPath, JSON.stringify(sealSourceRecordsManifest({ ...body, message_count: sidecar.message_count,
        sidecar_sha256: hashRegularFileNoFollow(indexPath) })));
      expect(() => selectedLine(h)).toThrow(/actual DB membership/);
      expect(semanticProposalCacheInputPaths(h.cWorkset(), join(root, "unread-cache"), TOKENS)).toContain(h.retained);
    }
  } finally { writeFileSync(indexPath, index); writeFileSync(manifestPath, manifest); }
});
