import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import { SoulMemorySearchResponseSchema, type Derivation, type FieldSnapshot, type InformationIndex, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteTrustStateRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { projectAcceptingIndex, indexEntryRevision } from "../../../../../../packages/core/src/recall/conditional-field/index/project-accepting-index.js";
import type { ExplanationDelivery } from "../../../../../../packages/core/src/recall/conditional-field/index/explanation-delivery.js";
import { productStateNodeId } from "../../../../../../packages/core/src/recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { openSourceSlice, WS, RUN, MEM } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { createRecallHandler, createReportContextUsageHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { TrustStateRecorder } from "../../../trust/state.js";
import { createDeps } from "../tool/mcp-memory-tool-handler-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const db of databases) db.close(); databases.clear(); });

describe("bounded explanation continuation delivery", () => {
  it("attaches the later forest to the prior product and records only newly exposed witnesses", async () => {
    const originalState = productKey(MEM.r);
    const state = { ...originalState, target: { ...originalState.target, workspace_id: WS } };
    const snapshot: FieldSnapshot = { schema_version: 1, query_id: "query", snapshot_id: SNAPSHOT_ID,
      values: [{ schema_version: 1, state, milligrades: 1000, accepting: true }],
      seeds: [{ schema_version: 1, state, milligrades: 1000 }], retained_transitions: [], facets: [] };
    const forest = new Map<string, Derivation>();
    forest.set("leaf", { schema_version: 1, derivation_id: "leaf", kind: "leaf", provenance_layout: "local_leaves.v1",
      children: [], observation_ids: [MEM.r], leaf_ids: [MEM.r], source_revisions: ["rev"], association_milligrades: 1000 });
    let root = "leaf";
    for (let index = 0; index < 50; index += 1) {
      const id = `shared-${index}`;
      forest.set(id, { schema_version: 1, derivation_id: id, kind: "and", provenance_layout: "local_leaves.v1",
        children: [root, "leaf"], observation_ids: [], leaf_ids: [], source_revisions: [] });
      root = id;
    }
    let progress: ExplanationDelivery | undefined;
    const pages: InformationIndex[] = [];
    for (let offset = 0; offset < 200; offset += 1) {
      const page = projectAcceptingIndex({ snapshot, query_id: "query", snapshot_id: SNAPSHOT_ID, result_version: "v1",
        view: defaultView(), budget: defaultBudget({ work_units: 4, finalization_reserve: 4, min_envelope: 0, page_budget: 1 }),
        derivation_forest: forest, output_derivation_roots: new Map([[productStateNodeId(state), [root]]]),
        grounding_complete: true, remaining_reserve: 4, remaining_memory_bytes: 1_000_000,
        expires_at: "2099-01-01T00:00:00.000Z", explanation_progress: progress,
        observer: { outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] },
        on_explanation_progress: (next) => { progress = next; },
        finalize_payload: (entries, allowance) => ({ remaining: allowance - entries.length, complete: true }) });
      pages.push({ ...page, interpretation_id: "interpretation", as_of: "2026-09-08T00:00:00.000Z" });
      if (progress === undefined) break;
    }
    expect(pages.flatMap((page) => page.entries).map((entry) => entry.object_id)).toEqual([MEM.r]);
    expect(pages[0]?.completeness.payload).not.toBe("complete");
    const proof = pages.at(-1)!;
    expect(proof.entries).toEqual([]);
    expect(proof.explanations).toHaveLength(51);
    expect(proof.product_updates).toEqual([{ schema_version: 1, product: state, update_kind: "proof",
      revision: root, previous_revision: indexEntryRevision(pages[0]!.entries[0]!) }]);

    const { database } = await openSourceSlice((db) => databases.add(db));
    const repo = new SqliteTrustStateRepo(database);
    const now = () => "2026-09-08T00:00:00.000Z";
    const recorder = new TrustStateRecorder({ ready: true, clock: now, repo,
      eventPublisher: new EventPublisher({ eventLogRepo: new SqliteEventLogRepo(database),
        runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } }) });
    const deps = { ...createDeps(), trustStateRecorder: recorder };
    const originalRecall = deps.recallService.recall;
    let current = pages[0]!;
    deps.recallService.recall = async (input) => {
      const recalled = await originalRecall(input);
      return { ...recalled, index: current, candidates: current.entries.length === 0 ? []
        : recalled.candidates.map((candidate) => ({ ...candidate, object_id: MEM.r })) };
    };
    const handler = createRecallHandler({ deps, now, generateId: randomUUID, warn: () => undefined });
    const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: RUN };
    const responses: SoulMemorySearchResponse[] = [];
    for (const page of [pages[0]!, proof]) {
      current = page;
      const response = SoulMemorySearchResponseSchema.parse(await handler({ query: "needle", max_results: 1,
        scope_class: null, dimension: null, domain_tags: null }, context));
      expect(response.results).toHaveLength(page.entries.length);
      expect(response.index?.page_purpose).toBe(page.page_purpose);
      responses.push(response);
    }
    expect(responses[0]!.delivery_id).not.toBe(responses[1]!.delivery_id);
    const deliveries = await Promise.all(responses.map((response) => repo.findDeliveryById(response.delivery_id)));
    expect(deliveries[0]?.delivered_object_ids).toEqual([MEM.r]);
    expect(deliveries[0]?.witness_exposures).toEqual([]);
    expect(deliveries[1]?.delivered_object_ids).toEqual([]);
    expect(deliveries[1]?.delivered_objects ?? []).toEqual([]);
    expect(deliveries[1]?.witness_exposures?.map((report) => report.witness_id).sort()).toEqual([...forest.keys()].sort());
    const exposure = deliveries[1]!.witness_exposures![0]!;
    const usage = createReportContextUsageHandler({ deps, now, warn: () => undefined });
    const report = { ...exposure, reported_use: "used" as const };
    for (const forged of [{ ...report, witness_id: "unexposed" }, { ...report, interpretation_id: "stale" }]) {
      await expect(usage({ delivery_id: responses[1]!.delivery_id, usage_state: "used", witness_reports: [forged] }, context)).rejects.toThrow();
    }
    const accepted = await usage({ delivery_id: responses[1]!.delivery_id, usage_state: "used", witness_reports: [report] }, context);
    expect(accepted.status).toBe("recorded");
    const history = await repo.listUsageByDeliveryIds([responses[1]!.delivery_id]);
    expect(history).toHaveLength(1);
    expect(history[0]?.witness_reports).toEqual([report]);
    expect(history[0]?.used_object_ids).toEqual([]);
  });
});
