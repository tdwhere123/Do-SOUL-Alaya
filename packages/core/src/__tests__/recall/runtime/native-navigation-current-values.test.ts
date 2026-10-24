import { expect, it } from "vitest";
import { MemoryDimension, QueryViewSchema, sourceGoldRootIdentity, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import type { FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { projectFromField } from "../../../recall/runtime/recall-field-projection.js";
import { startRequestCost } from "../../../recall/runtime/request-cost-ledger.js";
import type { ConditionalFieldRecallRequest } from "../../../recall/runtime/recall-service-runner-types.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { MEM, NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

it("uses current unreachable values after a same-cardinality navigation projection", async () => {
  let database: StorageDatabase | undefined;
  const slice = await openSourceSlice(db => { database = db; });
  try {
    await slice.writeMemory(MEM.r, "needle cache value", MemoryDimension.FACT);
    const source = hashedRecord(WS, "authored source", "catalog-source");
    new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(source);
    const target = sourceRecallTarget({ workspace_id: WS, root_kind: "source_record", root_id: source.record_id,
      source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: source.evidence_object_id });
    const budget = defaultBudget({ work_units: 10_000, memory_bytes: 1_000_000, page_budget: 1, finalization_reserve: 100 });
    const request: ConditionalFieldRecallRequest = { workspace_id: WS, query_text: "needle", budget,
      snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: NOW, as_of: NOW, lifetime_now: NOW,
      expires_at: FAR_FUTURE_EXPIRY, authorized_scopes: null, readers: readersFor(slice),
      protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["memory_entry", "source_evidence"] };
    const interpretation = compileConditionalFieldQuery({ source: "ordinary", text: request.query_text,
      budget, snapshot_id: request.snapshot_id, interpretation_clock: NOW, authorized_scopes: null,
      view: QueryViewSchema.parse({ schema_version: 1, requested_roles: ["requested", "associated"], enumeration_policy: "native_query",
        result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"] }) });
    const initial = observeField(interpretation, { workspace_id: WS, query_text: "needle", budget,
      as_of: NOW, readers: request.readers, authorized_scopes: null });
    let retained: FieldEngineState | undefined;
    const first = projectFromField({ ...initial, native_sources: { result: null, witness: [], admitted_roots: [target],
      catalog_positions: { [sourceGoldRootIdentity(target)]: 0 } } }, request, interpretation,
    state => { retained = state; }, startRequestCost());
    expect(first.entries.map(entry => entry.object_id)).toContain(MEM.r);
    if (retained?.binding.kind !== "bound") throw new Error("bound fixture expected");
    const changed: FieldEngineState = { ...retained, projection_progress: undefined, binding: { ...retained.binding,
      snapshot: { ...retained.binding.snapshot, values: retained.binding.snapshot.values.map(value => ({ ...value,
        activation: { kind: "unreachable" as const }, milligrades: undefined, low_milligrades: undefined, high_milligrades: undefined })) } } };
    const page = projectFromField(changed, request, interpretation, undefined, startRequestCost());
    expect(page.entries).toEqual([]);
  } finally { database?.close(); }
});
