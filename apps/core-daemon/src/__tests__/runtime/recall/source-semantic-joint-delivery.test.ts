import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); });
afterAll(() => { isolation.strict.restore(); isolation.safe.restore(); });

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type SourceSemanticCorrespondence, type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { type SourceFeedbackCorrespondenceAction, type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import type { SourceSemanticJointSelection } from "@do-soul/alaya-core/dist/recall/conditional-field/query/source-semantic-joint-witness.js";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { JOINT_QUESTION, APPROVAL_TIME, REVIEW_TIME, jointQuery, jointSource, jointCorrespondence,
  jointCacheResponse, jointSelection } from "./source-semantic-joint.test-support.js";
import { createSourceFeedbackCorrespondenceCache } from "../../../../../bench-runner/src/runs/semantic-chain/source-feedback-correspondence-cache.js";
import { materializeSemanticProposalLines } from "../../../../../bench-runner/src/runs/semantic-proposal/workset.js";
import { prepareSemanticProposal, executeSemanticProposalFill } from "../../../../../bench-runner/src/runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../../../bench-runner/src/runs/semantic-proposal/authority.js";
import { syntheticGeminiBody } from "../../../../../bench-runner/src/__tests__/runs/semantic-proposal/gemini-response-evidence.test-support.js";

const CONTEXT = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, principal: "joint-research" };
const GUARD = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/strict-provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
const PRODUCER = { model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1", provider_url: "http://127.0.0.1:9" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function retainDiscoveredCache(action: SourceFeedbackCorrespondenceAction, root: string) {
  const { original_query, query_semantics, descriptor } = action.request;
  const set = { ...PRODUCER, contract: "source-semantic-proposal-workset-v3" as const, kind: "semantic_correspondence" as const,
    items: [{ original_query, admitted_query_semantics: query_semantics,
      source_interpretation_descriptors: [{ source_interpretation_id: descriptor.interpretation_id, interpretation: descriptor.interpretation }] }] };
  const line = materializeSemanticProposalLines(set, 8192)[0]!, raw = jointCacheResponse(line.request as SourceSemanticCorrespondenceRequest);
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(set, root, 8192), inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  await executeSemanticProposalFill({ workset: set, cacheRoot: root, authority,
    config: { model: PRODUCER.model, providerUrl: PRODUCER.provider_url, requestProfile: "gemini-3.1-minimal-v1", apiKey: null },
    extractor: { extract: async () => ({ rawJson: raw, responseBody: syntheticGeminiBody(raw, "STOP"),
      responseMetadata: { finishReason: "STOP", completionWitness: "finish_reason" as const, completionContractVersion: 1 as const } }) } });
}

it("carries native Bridge navigation through the discovered H's own cache admission to private encoded delivery and causal withdrawal", async () => {
  process.execArgv.push(GUARD);
  try {
    const foils = Array.from({ length: 6 }, (_, n) => jointSource(`b${n}`, false, { value: `OTHER-${n}` }));
    await withAccessLibrary([jointSource("a", true), ...foils, jointSource("z", false)], async ({ filename, ids }) => {
      const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
      const cacheRoot = mkdtempSync(join(tmpdir(), "joint-correspondence-")); roots.push(cacheRoot);
      try {
        await client.ready();
        const q = jointQuery(), seedC = jointCorrespondence(ids.get("a")![0]!, true, q);
        const actionBudget = { ...ACCESS_BUDGET, work_units: 1_000_000, memory_bytes: 30_000_000 };
        const seed = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
          source_interpretation_id: seedC.source_interpretation_id, original_query: JOINT_QUESTION,
          query_semantics: q, semantic_correspondence: seedC, budget: actionBudget, output_byte_limit: 1_000_000 };
        const native = await client.sourceSemanticsPort!.execute({ ...CONTEXT, request: seed });
        if (native.kind !== "reason" || native.result?.source_target === undefined) throw new Error("native seed source target required");
        expect(native.result.binding_results?.some(b => b.kind === "evidence" && b.input === 0), JSON.stringify(native.result.outcome)).toBe(true);
        const session: SourceFeedbackSessionInput = { request_id: "joint-chain", parent_entitlement_id: "joint-original-allowance",
          workspace_id: WS, source_id: "a", source_target: native.result.source_target, original_query: JOINT_QUESTION,
          scope_identity: canonicalJson([CONTEXT.principal, CONTEXT.authorized_scopes]), as_of: CLOCK,
          seed, action_budget: actionBudget, budget: ACCESS_BUDGET };
        const collaborator = createSourceFeedbackCorrespondenceCache({ cache_root: cacheRoot, producer: PRODUCER, max_output_tokens: 8192 });
        let discovered!: SourceFeedbackCorrespondenceAction;
        const trace = await executeSourceFeedback({ session, context: CONTEXT, port: client.sourceSemanticsPort!, timeoutMs: 30_000,
          correspondence: { policy_id: collaborator.policy_id, async prepare(action) {
            discovered = action;
            expect(action.request.access_hint).toBe("TR-42");
            expect(action.request.descriptor.source_id).toBe("z");
            await retainDiscoveredCache(action, cacheRoot);
            return await collaborator.prepare(action);
          } } });
        expect(trace.qualification, JSON.stringify({ status: trace.status, qualification: trace.qualification, preparations: trace.preparations })).toMatchObject({ status: "local" });
        const ready = trace.preparations?.find(p => p.status === "ready");
        if (ready?.status !== "ready") throw new Error("actual discovered cache admission required");
        const local = trace.exposures.find(e => e.result.kind === "reason" && e.result.result?.source_interpretation_id === ids.get("z")![0])?.result;
        if (local?.kind !== "reason" || local.result?.source_target === undefined) throw new Error("native independent Approval required");
        expect(local.result.binding_results?.some(b => b.kind === "evidence" && b.input === 1)).toBe(true);
        expect(discovered.request.origin_exposure_id).toBe(trace.qualification?.status === "local" ? trace.qualification.origin_exposure_id : undefined);
        const selection = jointSelection(seedC, ready.semantic_correspondence, native.result.source_target, local.result.source_target);
        const budget = { ...ACCESS_BUDGET,
          work_units: ACCESS_BUDGET.work_units - trace.accounting.logical_work - native.work.logical_work!,
          memory_bytes: ACCESS_BUDGET.memory_bytes - trace.accounting.logical_memory_bytes - native.work.logical_memory_bytes };
        const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = { kind: "recall", accepts_unreviewed_conditional_results: true,
          original_query: JOINT_QUESTION, query_semantics: q, access_policy: "query-conditioned-v1", output_byte_limit: 1_000_000, budget,
          semantic_correspondences: [seedC, ready.semantic_correspondence, ...foils.map(f => jointCorrespondence(ids.get(f.id)![0]!, false, q))] };
        const pending = client.researchLibrary!.recall({ ...CONTEXT, request }, selection);
        Object.assign(selection.approval.time, { source_slot: "ingestionTime" });
        const reply = await pending;
        if (reply.kind !== "research_joint") throw new Error("private worker encoding boundary required");
        const privateResult = reply.private_joint;
        expect(privateResult.status, privateResult.reason ?? JSON.stringify(privateResult.assessment)).toBe("complete");
        expect(privateResult.assessment).toMatchObject({ status: "witnessed", world_claim: "unknown", semantic_status: "unreviewed",
          witness: { ticket: { kind: "issue", issuer: "Forge", project: "Pilot", normalization: "exact", value: "TR-42" },
            approval_times: [{ value: APPROVAL_TIME }], review_times: [{ value: REVIEW_TIME }] } });
        expect(privateResult.witness_delivered).toBe(true);
        expect(privateResult.assessment?.witness?.selection.approval.time.source_slot).toBe("eventTime");
        const candidate = privateResult.candidate!, withdrawn = privateResult.withdrawal!;
        expect(candidate.full_envelope_bytes).toBeLessThanOrEqual(request.output_byte_limit);
        expect(JSON.parse(candidate.serialized)).toEqual(candidate.artifact);
        const actual = candidate.artifact.proofs ?? [];
        expect(actual.some(p => p.source_interpretation_id === seedC.source_interpretation_id)).toBe(true);
        expect(actual.some(p => p.source_interpretation_id === ready.semantic_correspondence.source_interpretation_id)).toBe(true);
        expect(candidate.serialized).toContain("TR-42"); expect(candidate.serialized).toContain(APPROVAL_TIME);
        expect(candidate.artifact.index.entries.slice(0, 2).map(e => e.target)).not.toEqual(reply.result.index.entries.slice(0, 2).map(e => e.target));
        expect((reply.result.proofs ?? []).every(p => p.world_claim === "unknown")).toBe(true);
        expect(withdrawn).toMatchObject({ leaf: { leaf_kind: "source_interpretation_presence", occurrence: "fBridge" },
          assessment: { status: "unresolved", witness: null }, independent_approval_preserved: true });
        const revokedProofs = withdrawn.delivery.artifact.proofs ?? [];
        expect(revokedProofs.some(p => p.source_interpretation_id === seedC.source_interpretation_id)).toBe(false);
        expect(revokedProofs.some(p => p.source_interpretation_id === ready.semantic_correspondence.source_interpretation_id)).toBe(true);
        expect(privateResult.work.logical_work).toBeLessThanOrEqual(budget.work_units);
        expect(privateResult.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
      } finally { await client.close(); }
    });
  } finally { process.execArgv.splice(process.execArgv.lastIndexOf(GUARD), 1); }
}, 90_000);

it.each(["key", "namespace", "namespace_case", "unknown_namespace", "normalization", "time", "missing_time", "unknown_offset", "overlap", "reversed_time",
  "module", "wrong_module_source", "time_role", "negated", "modal", "stale", "diagnostic_budget"] as const)(
  "preserves honest locals and refuses the dependent witness for %s", async mode => {
    process.execArgv.push(GUARD);
    try {
      await withAccessLibrary([jointSource("a", true, mode === "wrong_module_source" ? { reviewModule: "M8" } : {}), jointSource("z", false,
        mode === "key" ? { value: "TR-73" } : mode === "namespace" ? { issuer: "Elsewhere" } : mode === "namespace_case" ? { issuer: "forge" }
          : mode === "unknown_namespace" ? { project: "unknown" } : mode === "normalization" ? { normalization: "casefold" }
          : mode === "time" ? { time: "2026-09-16" } : mode === "missing_time" ? { time: "unspecified" }
          : mode === "unknown_offset" ? { time: "2026-09-16T09:00:00-00:00" }
          : mode === "overlap" ? { time: REVIEW_TIME } : mode === "reversed_time" ? { time: "2026-09-18T10:00:00+00:00" }
          : mode === "negated" ? { modality: "not" } : mode === "modal" ? { modality: "possible" } : {})], async ({ filename, ids, execute }) => {
        const q = jointQuery(), cs = [jointCorrespondence(ids.get("a")![0]!, true, q), jointCorrespondence(ids.get("z")![0]!, false, q)];
        const targets = [];
        for (const c of cs) {
          const local = await execute({ ...CONTEXT, request: { kind: "reason", accepts_unreviewed_conditional_results: true,
            original_query: JOINT_QUESTION, source_interpretation_id: c.source_interpretation_id,
            query_semantics: q, semantic_correspondence: c, budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 } });
          if (local.kind !== "reason" || local.result?.source_target === undefined) throw new Error("native local required");
          targets.push(local.result.source_target);
        }
        const s = jointSelection(cs[0]!, cs[1]!, targets[0]!, targets[1]!);
        const selection: SourceSemanticJointSelection = mode === "module" ? { ...s, seed: { ...s.seed, review_module: { ...s.seed.review_module, variable: "otherModule" } } }
          : mode === "time_role" ? { ...s, approval: { ...s.approval, time: { ...s.approval.time, source_slot: "ingestionTime" } } } : s;
        if (mode === "stale") {
          const db = new DatabaseSync(filename);
          try { db.prepare("UPDATE source_records SET source_version='2' WHERE source_id='a'").run(); } finally { db.close(); }
        }
        const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
        try {
          await client.ready();
          const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = { kind: "recall", accepts_unreviewed_conditional_results: true,
            original_query: JOINT_QUESTION, query_semantics: q, semantic_correspondences: cs,
            access_policy: "query-conditioned-v1", budget: mode === "diagnostic_budget" ? { ...ACCESS_BUDGET, memory_bytes: 12_000_000 } : ACCESS_BUDGET,
            output_byte_limit: 1_000_000 };
          const reply = await client.researchLibrary!.recall({ ...CONTEXT, request }, selection);
          if (reply.kind !== "research_joint") throw new Error("private reply required");
          expect(reply.private_joint.assessment?.status).not.toBe("witnessed");
          expect(reply.private_joint.assessment?.witness ?? null).toBeNull();
          expect((reply.result.proofs ?? []).every(p => p.world_claim === "unknown")).toBe(true);
          expect(reply.private_joint.witness_delivered).toBe(false);
          if (!["diagnostic_budget", "negated", "modal", "unknown_namespace"].includes(mode)) {
            expect((reply.result.proofs ?? []).some(p => p.source_interpretation_id === cs[1]!.source_interpretation_id)).toBe(true);
          }
          if (mode === "diagnostic_budget") {
            expect(reply.private_joint.status).toBe("failed");
            expect(reply.private_joint.reason).toContain("resource_exhausted");
            const incumbent = await client.researchLibrary!.recall({ ...CONTEXT, request });
            if (incumbent.kind !== "recall") throw new Error("ordinary local delivery required");
            expect(reply.result.index.entries.map(e => e.target)).toEqual(incumbent.index.entries.map(e => e.target));
          }
          expect(reply.private_joint.work.logical_work).toBeLessThanOrEqual(request.budget.work_units);
          expect(reply.private_joint.work.logical_memory_bytes).toBeLessThanOrEqual(request.budget.memory_bytes);
          if (mode === "time" || mode === "missing_time" || mode === "unknown_offset") expect(reply.private_joint.assessment?.status).toBe("not_lowered");
          if (mode === "stale") expect((reply.result.proofs ?? []).some(p => p.source_interpretation_id === cs[0]!.source_interpretation_id)).toBe(false);
        } finally { await client.close(); }
      });
    } finally { process.execArgv.splice(process.execArgv.lastIndexOf(GUARD), 1); }
  }, 60_000);
