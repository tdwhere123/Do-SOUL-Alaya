import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); });
afterAll(() => { isolation.strict.restore(); isolation.safe.restore(); });

import { initDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import type { SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { issueSemanticLeaseGroup, readSemanticLease, sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import type { ResearchJointReply } from "../../../runtime/recall-read-worker/source-semantic-joint-boundary.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { JOINT_QUESTION, jointQuery, jointSource, jointCorrespondence, jointSelection } from "./source-semantic-joint.test-support.js";

const CONTEXT = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, principal: "joint-research" };
const GUARD = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/strict-provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
const SOURCES = [jointSource("a", true), ...Array.from({ length: 6 }, (_, n) => ({ id: `b${n}`, text: `M7 independent raw memo ${n}.` })), jointSource("z", false)];
type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;

async function withJointLibrary(body: (fixture: { filename: string; request: Request;
  selection: ReturnType<typeof jointSelection> }) => Promise<void>) {
  process.execArgv.push(GUARD);
  try {
    await withAccessLibrary(SOURCES, async ({ filename, ids, execute }) => {
      const q = jointQuery(), cs = [jointCorrespondence(ids.get("a")![0]!, true, q), jointCorrespondence(ids.get("z")![0]!, false, q)];
      const targets = [];
      for (const c of cs) {
        const local = await execute({ ...CONTEXT, request: { kind: "reason", accepts_unreviewed_conditional_results: true,
          original_query: JOINT_QUESTION, source_interpretation_id: c.source_interpretation_id,
          query_semantics: q, semantic_correspondence: c, budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 } });
        if (local.kind !== "reason" || local.result?.source_target === undefined) throw new Error("native local required");
        targets.push(local.result.source_target);
      }
      await body({ filename, request: { kind: "recall", accepts_unreviewed_conditional_results: true,
        original_query: JOINT_QUESTION, query_semantics: q, semantic_correspondences: cs,
        access_policy: "query-conditioned-v1", budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 },
        selection: jointSelection(cs[0]!, cs[1]!, targets[0]!, targets[1]!) });
    });
  } finally { process.execArgv.splice(process.execArgv.lastIndexOf(GUARD), 1); }
}

it.each(["complete", "failed"] as const)("resumes the native five-root page through the official worker port after %s private diagnostics", async status => {
  await withJointLibrary(async ({ filename, request: original, selection }) => {
    const request = status === "failed" ? { ...original, budget: { ...original.budget, memory_bytes: 50_000_000 } } : original;
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 2 })!;
    try {
      await client.ready();
      const reply = await client.researchLibrary!.recall({ ...CONTEXT, request }, selection);
      if (reply.kind !== "research_joint") throw new Error("private reply required");
      expect(reply.private_joint.status, reply.private_joint.reason ?? "complete").toBe(status);
      expect(reply.result.index.entries).toHaveLength(5);
      const continuation = reply.result.index.continuation;
      expect(continuation).not.toBeNull();
      const next = await client.sourceSemanticsPort!.execute({ ...CONTEXT, request: { ...request, continuation: continuation! } });
      if (next.kind !== "recall") throw new Error("ordinary native continuation required");
      expect(next.index.entries).toHaveLength(3);
      expect(next.index.continuation).toBeNull();
      const roots = [...reply.result.index.entries, ...next.index.entries].map(e => e.target.kind === "source_evidence" ? e.target.root_id : "not-source");
      expect(new Set(roots).size).toBe(8);
      expect(roots).not.toContain("not-source");
      expect(next.index.snapshot_id).toBe(reply.result.index.snapshot_id);
      expect(next.request_identity).toBe(reply.result.request_identity);
      for (const page of [reply.private_joint.candidate, reply.private_joint.withdrawal?.delivery]) {
        if (page == null) continue;
        expect(page.artifact).not.toHaveProperty("delivery_id");
        expect(page.artifact).not.toHaveProperty("request_identity");
        expect(page.artifact.index).not.toHaveProperty("continuation");
      }
    } finally { await client.close(); }
  });
}, 60_000);

it.each(["complete", "failed"] as const)("publishes only the native lease at full inventory after %s private diagnostics", async status => {
  await withJointLibrary(async ({ filename, request: original, selection }) => {
    const database = initDatabase({ filename });
    try {
      const runtime = createRecallReadWorkerRuntime(database);
      const lease = { ...CONTEXT, kind: "query" as const, authorized: ["project"],
        expires_at: "2026-09-18T00:10:00.000Z", revision: sourceSemanticRevision(runtime) };
      issueSemanticLeaseGroup(runtime, Array.from({ length: 32 }, (_, i) => ({ issuedId: `older-${i}`, lease })), new SourceSemanticReadBudget(ACCESS_BUDGET));
      const request = status === "failed" ? { ...original, budget: { ...original.budget, memory_bytes: 50_000_000 } } : original;
      const reply = runSourceSemanticWorker(runtime, { ...CONTEXT, request, joint_control: selection });
      if (reply.kind !== "research_joint") throw new Error("private reply required");
      expect(reply.private_joint.status, reply.private_joint.reason ?? "complete").toBe(status);
      const continuation = reply.result.index.continuation!;
      expect(continuation).not.toBeNull();
      expect(readSemanticLease(runtime, CONTEXT, continuation.continuation_id, ["project"], "library").library_plan!.pages).toHaveLength(2);
      // Independent capacity expectation: exactly one native capability displaces exactly one old row.
      expect(() => readSemanticLease(runtime, CONTEXT, "older-0", ["project"], "query")).toThrow(/expired/u);
      for (let i = 1; i < 32; i++) expect(readSemanticLease(runtime, CONTEXT, `older-${i}`, ["project"], "query")).toBe(lease);
      const next = runSourceSemanticWorker(runtime, { ...CONTEXT, request: { ...request, continuation } });
      if (next.kind !== "recall") throw new Error("native continuation required");
      expect(next.index.entries).toHaveLength(3);
    } finally { database.close(); closeCachedDatabase(filename); }
  });
}, 60_000);

function captureTransport() {
  const charges: { work: number; bytes: number; spent: number; held: number; meter: SourceSemanticReadBudget }[] = [];
  const charge = SourceSemanticReadBudget.prototype.charge;
  vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, work, bytes, phase) {
    if (phase === "research private reply encoding and worker transport") {
      charges.push({ work, bytes, spent: this.spentWork, held: this.outstandingAllowance().work_units - this.spentWork, meter: this });
    }
    charge.call(this, work, bytes, phase);
  });
  return charges;
}

/** Independent wire expectation: all outer fields and the native sibling, with the final work
 * receipt bounded by the original budget. Do not call the production serializer or reservation.
 */
function expectedWireLength(reply: ResearchJointReply, request: Request): number {
  return JSON.stringify({ ...reply, private_joint: { ...reply.private_joint, work: {
    native_work: request.budget.work_units, index_work: request.budget.work_units, native_accounting: "complete",
    logical_work: request.budget.work_units, native_bytes: request.budget.memory_bytes,
    logical_memory_bytes: request.budget.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER
  } } }).length;
}

it.each(["complete", "early", "query_unavailable", "failed"] as const)("prices the final outer worker reply including its final work receipt on the %s path", async mode => {
  await withJointLibrary(async ({ filename, request: original, selection }) => {
    const database = initDatabase({ filename });
    try {
      const runtime = createRecallReadWorkerRuntime(database), charges = captureTransport();
      const request = mode === "failed" ? { ...original, budget: { ...original.budget, memory_bytes: 12_000_000 } }
        : mode === "query_unavailable" ? { ...original, query_semantics: undefined, semantic_correspondences: undefined } : original;
      const selected = mode === "early" ? { ...selection, seed: { ...selection.seed, bridge: { ...selection.seed.bridge, source_frame: "absent" } } } : selection;
      const reply = runSourceSemanticWorker(runtime, { ...CONTEXT, request, joint_control: selected });
      if (reply.kind !== "research_joint") throw new Error("private reply required");
      expect(reply.private_joint.status).toBe(mode === "early" || mode === "query_unavailable" ? "unavailable" : mode);
      if (mode === "query_unavailable") expect(reply.private_joint).toMatchObject({ reason: "selected_semantics_unavailable", assessment: null, candidate: null });
      if (mode === "early") {
        expect(reply.private_joint.reason).toBe("bridge_withdrawal_unavailable");
        expect(reply.private_joint.candidate).not.toBeNull();
      }
      expect(charges).toHaveLength(1);
      const final = charges[0]!;
      expect(final.work).toBe(expectedWireLength(reply, request));
      expect(final.bytes).toBe(2 * expectedWireLength(reply, request));
      expect(final.work).toBeGreaterThanOrEqual(JSON.stringify(reply).length);
      expect(reply.private_joint.work.logical_work).toBe(final.spent + final.work);
      expect(reply.private_joint.work.logical_memory_bytes).toBe(final.meter.spentBytes);
      expect(reply.private_joint.work.logical_work).toBeLessThanOrEqual(request.budget.work_units);
      expect(reply.private_joint.work.logical_memory_bytes).toBeLessThanOrEqual(request.budget.memory_bytes);
      expect(reply.private_joint.work.logical_work).toBeGreaterThan(reply.result.work.logical_work!);
      expect(reply.private_joint.request_identity).not.toBe(reply.result.request_identity);
    } finally { database.close(); closeCachedDatabase(filename); }
  });
}, 60_000);

it("drops an already computed candidate when the final outer wire cannot be paid, retaining native delivery and known work", async () => {
  await withJointLibrary(async ({ filename, request: original, selection }) => {
    const database = initDatabase({ filename });
    try {
      const request = { ...original, budget: { ...original.budget, work_units: 9_000_000 } }, charges = captureTransport();
      const ample = runSourceSemanticWorker(createRecallReadWorkerRuntime(database), { ...CONTEXT, request, joint_control: selection });
      if (ample.kind !== "research_joint") throw new Error("private reply required");
      expect(ample.private_joint.status).toBe("complete");
      const final = charges[0]!;
      const tight = { ...request, budget: { ...request.budget, work_units: final.spent + final.held + final.work - 1000 } };
      expect(String(tight.budget.work_units).length).toBe(String(request.budget.work_units).length);
      charges.length = 0;
      const reply = runSourceSemanticWorker(createRecallReadWorkerRuntime(database), { ...CONTEXT, request: tight, joint_control: selection });
      if (reply.kind !== "research_joint") throw new Error("private reply required");
      expect(reply.private_joint).toMatchObject({ status: "failed", candidate: null, assessment: null, withdrawal: null, witness_delivered: false });
      expect(reply.private_joint.reason).toContain("resource_exhausted:research private reply encoding and worker transport");
      expect(charges).toHaveLength(2); // Refused large wire followed by the protected failed diagnostic.
      expect(charges[1]!.work).toBe(expectedWireLength(reply, tight));
      expect(reply.private_joint.work.logical_work).toBe(charges[1]!.spent + charges[1]!.work);
      expect(reply.private_joint.work.logical_work).toBeLessThanOrEqual(tight.budget.work_units);
      expect(reply.result.index.entries.map(e => e.target)).toEqual(ample.result.index.entries.map(e => e.target));
      expect(reply.result.index.continuation).not.toBeNull();
    } finally { database.close(); closeCachedDatabase(filename); }
  });
}, 60_000);
