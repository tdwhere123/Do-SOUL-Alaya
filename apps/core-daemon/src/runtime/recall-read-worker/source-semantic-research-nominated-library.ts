import { z } from "zod";
import { canonicalJson, sourceSemanticAccessPhases, sourceSemanticExecution, SourceSemanticResourceExhausted,
  SoulInterpretationResponseSchema, SourceSemanticWorkerResultSchema, IndexEntrySchema,
  type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { CoreError, admitSourceSemanticQuery, authorizedScopesFromAdmission, encodeSourceSemanticLibraryResponse,
  fieldContractSha256, selectSourceSemanticLibraryPage, sourceGoldRootIdentity,
  sourceSemanticLibraryRequestIdentity, sourceSemanticQueryStatus, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "./runtime.js";
import { workOf, type SourceSemanticWorkerPayload } from "./source-semantic-discovery.js";
import { accessInputIdentity, bindAccessPoolIdentity, type SourceSemanticAccessPool } from "./source-semantic-candidate-access.js";
import { bindVerifiedResearchSourceRecords } from "./source-semantic-research-pool.js";
import { executeLibraryBranches, prepareSourceSemanticLibraryInputs } from "./source-semantic-library-recall.js";
import { deliverFrozenLibraryPage, prepareLibraryDelivery, type LibraryPageSelector } from "./source-semantic-library-delivery.js";

type Proposal = Readonly<{ root: string; position: number; provenance: "primary" | "supplemental" | "legacy-access remainder" }>;
type Prepared = ReturnType<typeof prepareSourceSemanticLibraryInputs>;
type Runtime = ReturnType<typeof createRecallReadWorkerRuntime>;
type Request = Extract<SourceSemanticWorkerPayload["request"], { kind: "recall" }>;

// Project the existing wire leaves, without admitting routable delivery identities.
type NativeRecallSchemaType = (typeof SourceSemanticWorkerResultSchema)["options"][4];
type NativeRecall = z.output<NativeRecallSchemaType>;
const NativeRecallSchema: z.ZodType<NativeRecall, z.input<NativeRecallSchemaType>> = SourceSemanticWorkerResultSchema.options[4];
const nativeShape = SourceSemanticWorkerResultSchema.options[4].unwrap().shape;
const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
  protocol_version: _protocol, index: _index, ...privateContentShape } = SoulInterpretationResponseSchema.options[4].unwrap().shape;
const { continuation: _continuation, ...privateIndexShape } = nativeShape.index.unwrap().shape;
const PrivateArtifactSchema = z.object({ ...privateContentShape,
  index: z.object(privateIndexShape).strict(), frozen_plan_has_more: z.boolean() }).strict();
const ProposalSchema = z.object({ root: z.string(), position: z.number().int().nonnegative(),
  provenance: z.enum(["primary", "supplemental", "legacy-access remainder"]) }).strict();
const PrivateArmSchemaOwner = z.object({
  kind: z.literal("PRIVATE_COUNTERFACTUAL"), policy: z.string(), proposals: z.array(ProposalSchema).optional(),
  full_envelope_bytes: z.number().int().nonnegative(), output_byte_limit: z.number().int().positive(),
  fit_template: z.literal("unchanged native full envelope; not an executed evidence_support ranking claim"),
  artifact: PrivateArtifactSchema,
  package_repertoire: z.array(z.object({ target: IndexEntrySchema.unwrap().shape.target, proofs: nativeShape.proofs.unwrap() }).strict()),
  frozen_pages: z.array(z.array(z.object({ target: IndexEntrySchema.unwrap().shape.target,
    preview: z.string(), proofs: nativeShape.proofs.unwrap() }).strict()))
}).strict();
type PrivateArm = z.output<typeof PrivateArmSchemaOwner>;
const PrivateArmSchema: z.ZodType<PrivateArm, z.input<typeof PrivateArmSchemaOwner>> = PrivateArmSchemaOwner;
type ComparisonArms<Keys extends string> = { [Key in Keys]: z.ZodNullable<typeof PrivateArmSchema> };
type ComparisonSchemaType = z.ZodObject<{
  query_semantics_status: (typeof nativeShape)["query_semantics_status"];
  hydration: ReturnType<z.ZodObject<ComparisonArms<"prefix" | "nominated">>["strict"]>;
  ordering: ReturnType<z.ZodObject<ComparisonArms<"o1" | "access" | "native">>["strict"]>;
}>;
const ComparisonSchema: ReturnType<ComparisonSchemaType["strict"]> = z.object({ query_semantics_status: nativeShape.query_semantics_status,
  hydration: z.object({ prefix: PrivateArmSchema.nullable(), nominated: PrivateArmSchema.nullable() }).strict(),
  ordering: z.object({ o1: PrivateArmSchema.nullable(), access: PrivateArmSchema.nullable(), native: PrivateArmSchema.nullable() }).strict()
}).strict();
const PhaseCostSchema = z.object({ phase: z.enum(["shared", "prefix_preparation", "nominated_preparation", "prefix", "nominated", "access", "native"]),
  work: nativeShape.work }).strict();

/** Daemon-private diagnostics, never a native envelope or answer/consumer-benefit claim. */
const deliveryStateShape = {
  kind: z.literal("PRIVATE_COUNTERFACTUAL"), status: z.enum(["not_run", "unavailable", "partial", "complete"]),
  reason: z.string().nullable(),
  failure: z.object({ name: z.string(), message: z.string(), code: z.string().nullable(), phase: z.string().nullable() }).strict().nullable()
};
const deliveryCostShape = {
  captured: z.object({ work: nativeShape.work, execution: nativeShape.execution.unwrap() }).strict(),
  // Each phase is cumulative within its own counterfactual fork, not an additive physical-work total.
  costs: z.array(PhaseCostSchema)
};
const deliveryDiagnosticsShape: typeof deliveryStateShape & typeof deliveryCostShape & {
  comparison: z.ZodNullable<typeof ComparisonSchema>;
} = { ...deliveryStateShape, ...deliveryCostShape, comparison: ComparisonSchema.nullable() };
type DeliveryDiagnosticsSchemaType = ReturnType<z.ZodObject<typeof deliveryDiagnosticsShape>["strict"]>;
const ResearchSourceDeliveryDiagnosticsSchemaOwner: DeliveryDiagnosticsSchemaType = z.object(deliveryDiagnosticsShape).strict().superRefine((value, context) => {
  const complete = value.comparison !== null && [...Object.values(value.comparison.hydration),
    ...Object.values(value.comparison.ordering)].every(arm => arm !== null);
  if (value.status === "complete" && (!complete || value.reason !== null)
    || value.status === "partial" && value.failure === null
    || value.status !== "partial" && value.failure !== null
    || value.status !== "complete" && value.reason === null
    || value.status === "not_run" && (value.comparison !== null || value.costs.length !== 0)) {
    context.addIssue({ code: "custom", message: "private delivery status must preserve comparison/failure availability" });
  }
});
export type ResearchSourceDeliveryDiagnostics = z.output<typeof ResearchSourceDeliveryDiagnosticsSchemaOwner>;
export const ResearchSourceDeliveryDiagnosticsSchema: z.ZodType<ResearchSourceDeliveryDiagnostics,
  z.input<typeof ResearchSourceDeliveryDiagnosticsSchemaOwner>> = ResearchSourceDeliveryDiagnosticsSchemaOwner;
const acquisitionReplyTag = { kind: z.literal("research_acquisition") };
const acquisitionReplyShape: typeof acquisitionReplyTag & {
  result: typeof NativeRecallSchema; private_delivery: typeof ResearchSourceDeliveryDiagnosticsSchema;
} = { ...acquisitionReplyTag, result: NativeRecallSchema, private_delivery: ResearchSourceDeliveryDiagnosticsSchema };
type AcquisitionReplySchemaType = z.ZodReadonly<ReturnType<z.ZodObject<typeof acquisitionReplyShape>["strict"]>>;
const ResearchSourceAcquisitionReplySchemaOwner: AcquisitionReplySchemaType = z.object(acquisitionReplyShape).strict().readonly();
export type ResearchSourceAcquisitionReply = z.output<typeof ResearchSourceAcquisitionReplySchemaOwner>;
export const ResearchSourceAcquisitionReplySchema: z.ZodType<ResearchSourceAcquisitionReply,
  z.input<typeof ResearchSourceAcquisitionReplySchemaOwner>> = ResearchSourceAcquisitionReplySchemaOwner;
type DeliveryProgress = Pick<ResearchSourceDeliveryDiagnostics, "costs" | "comparison"> & { located: boolean };
type CostPhase = z.infer<typeof PhaseCostSchema>["phase"];

/** A failed diagnostic keeps its native sibling and all already measured fork costs/results. */
export function captureResearchNominatedSourceDelivery(database: StorageDatabase, payload: SourceSemanticWorkerPayload,
  pool: SourceSemanticAccessPool | undefined, capturedCosts: SourceSemanticReadBudget,
  notRunReason = "live_access_pool_unavailable"): ResearchSourceDeliveryDiagnostics {
  const captured = { work: workOf(capturedCosts), execution: sourceSemanticExecution(capturedCosts.preparation, capturedCosts.acquisition) };
  const progress: DeliveryProgress = { costs: [], comparison: null, located: false };
  if (pool === undefined) return { kind: "PRIVATE_COUNTERFACTUAL", status: "not_run", reason: notRunReason,
    captured, costs: [], comparison: null, failure: null };
  try {
    compareResearchNominatedSourceLibrary(database, payload, pool, capturedCosts, progress);
    return { kind: "PRIVATE_COUNTERFACTUAL", status: progress.located ? "complete" : "unavailable",
      reason: progress.located ? null : "no_located_nominations", captured, costs: progress.costs, comparison: progress.comparison, failure: null };
  } catch (error) {
    return { kind: "PRIVATE_COUNTERFACTUAL", status: "partial", reason: "comparison_failed", captured,
      costs: progress.costs, comparison: progress.comparison, failure: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message.slice(0, 512) : "private comparison failed",
        code: error instanceof CoreError ? error.code : null,
        phase: error instanceof SourceSemanticResourceExhausted ? error.phase : null
      } };
  }
}

function retainPhaseCost<T>(progress: DeliveryProgress | undefined, phase: CostPhase,
  meter: SourceSemanticReadBudget, run: () => T): T {
  try { return run(); } finally { progress?.costs.push({ phase, work: workOf(meter) }); }
}

/**
 * Named caller: compareResearchNominatedSourceLibrary's private controlled comparison.
 * Remove if it has no reproducible utility or distinct policy answer versus the simpler
 * access-order ablation; retire on reviewed public promotion. No product ranking option.
 */
export function projectResearchNativeProposals(candidates: readonly SourceSemanticLibraryPackage[],
  acquisition: SourceSemanticAcquisitionPhase, meter: SourceSemanticReadBudget) {
  const roots = new Set<string>();
  const proposals: Proposal[] = [];
  const eligible = new Set(candidates.map(row => packageRoot(row)));
  meter.charge(candidates.length, candidates.length * 32, "research proposal root census");
  const append = (root: string, provenance: Proposal["provenance"]) => {
    meter.charge(1, 0, "research root proposal check");
    if (!eligible.has(root) || roots.has(root)) return;
    meter.charge(1, 128 + root.length * 2, "research root proposal retention");
    roots.add(root); proposals.push({ root, position: proposals.length, provenance });
  };
  for (const [phase, provenance] of [[acquisition, "primary"],
    ...(acquisition.supplemental ?? []).map(phase => [phase, "supplemental"] as const)] as const) {
    for (const nomination of phase.result?.nominations ?? []) {
      if (nomination.source.root_key !== sourceGoldRootIdentity(nomination.source.target)) {
        throw new CoreError("CONFLICT", "native proposal root key does not match its target");
      }
      append(nomination.source.root_key, provenance);
    }
  }
  meter.charge(candidates.length * Math.max(1, Math.ceil(Math.log2(candidates.length))), candidates.length * 8,
    "research legacy access order");
  for (const row of [...candidates].sort((a, b) => a.access_position - b.access_position)) {
    append(packageRoot(row), "legacy-access remainder");
  }
  return proposals;
}

/** Ordering projection only: the existing selector still owns variants, root occupancy and fit. */
export function researchNativeProposalSelector(proposals: readonly Proposal[]): LibraryPageSelector {
  const positions = new Map(proposals.map(row => [row.root, row.position]));
  return input => {
    input.meter.charge(input.candidates.length, input.candidates.length * 256, "research private ordering projection");
    const candidates = input.candidates.map(row => {
      const position = positions.get(packageRoot(row));
      if (position === undefined) throw new CoreError("CONFLICT", "package is outside the frozen proposal sequence");
      return { ...row, access_position: position };
    });
    // Stable equal positions preserve all prepared window/qualification variants of a root.
    // A rejected root advances to the next GLOBAL proposal, never a same-route refill.
    return selectSourceSemanticLibraryPage({ ...input, candidates, order: "source_access" });
  };
}

/**
 * Explicit request-local opt-in over an already captured native access pool and its costs.
 * This is mechanism/counterfactual evidence, not a native response, consumer gain or promotion.
 * No acquisition, producer, provider, feedback or continuation protocol is introduced here.
 */
export function compareResearchNominatedSourceLibrary(database: StorageDatabase, payload: SourceSemanticWorkerPayload,
  pool: SourceSemanticAccessPool, capturedCosts: SourceSemanticReadBudget, progress?: DeliveryProgress) {
  const request = payload.request;
  if (request.kind !== "recall" || request.original_query === undefined || request.query_handle !== undefined
    || request.continuation !== undefined || request.access_policy !== "query-conditioned-v1") {
    throw new CoreError("VALIDATION", "nominated comparison requires one direct frozen-pool research request");
  }
  const original = request.original_query, policy = request.access_policy;
  const authorized = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
  if (authorized === undefined) throw new CoreError("VALIDATION", "research comparison requires admitted scopes");
  const runtime = createRecallReadWorkerRuntime(database), meter = forkCapturedRequestBudget(request, capturedCosts);
  return retainPhaseCost(progress, "shared", meter, () => {
  meter.retain([request, pool], "research captured request and access pool");
  const admission = admitSourceSemanticQuery(request.query_semantics, original);
  const query = admission.kind === "admitted" ? admission.query : undefined;
  const status = sourceSemanticQueryStatus(admission, request.query_semantics_unavailable);
  if (pool.access.input_id !== accessInputIdentity(original, query, request.budget, policy,
    undefined, pool.sourcePreviewExtents, pool.accessHint)) throw new CoreError("CONFLICT", "research access request binding changed");
  const { pool_id, ...receipt } = pool.access;
  if (bindAccessPoolIdentity(runtime, payload.workspace_id, authorized, receipt, meter).pool_id !== pool_id) {
    throw new CoreError("CONFLICT", "research access scope or source revision changed");
  }
  const observations = pool.sources.map(record => {
    const row = pool.access.source_candidates.find(row => row.record_id === record.identity && row.source_id === record.source_id);
    if (row === undefined) throw new CoreError("CONFLICT", "captured source observation is missing");
    return { ...row, source_version: record.source_version, content_digest: record.content_digest };
  });
  meter.charge(pool.sources.length * pool.access.source_candidates.length, observations.length * 256,
    "research captured observation binding");
  const records = bindVerifiedResearchSourceRecords(runtime, payload.workspace_id, authorized, meter, observations);
  const acquisition = sourceSemanticAccessPhases(pool.access, meter).acquisition;
  const nominations = [acquisition, ...(acquisition.supplemental ?? [])].flatMap(phase => phase.result?.nominations ?? []);
  if (progress !== undefined) progress.located = nominations.some(row => row.vector !== null);
  const branches = query === undefined
    ? { proofGroups: [], proofs: [], unproved: [], examined: [], supports: [], pairs: 0,
      executedCount: 0, computeOpen: false, interpretationTruncated: false }
    : executeLibraryBranches(runtime, payload, authorized, meter, pool.descriptors, request, query, original);
  const requestIdentity = fieldContractSha256(canonicalJson({ ...request, continuation: undefined }));
  const publicIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: payload.workspace_id, as_of: payload.as_of,
    authorized_scopes: authorized, original_query: original, query_semantics: query, query_semantics_status: status,
    semantic_correspondences: request.semantic_correspondences ?? [], budget: request.budget,
    output_byte_limit: request.output_byte_limit, access_policy: policy,
    ...(pool.accessHint === undefined ? {} : { access_hint: pool.accessHint }) });
  const partial: NonNullable<DeliveryProgress["comparison"]> = { query_semantics_status: status,
    hydration: { prefix: null, nominated: null }, ordering: { o1: null, access: null, native: null } };
  if (progress !== undefined) progress.comparison = partial;
  const capture = (nominated: boolean) => {
    const preparation = forkCapturedRequestBudget(request, meter);
    return retainPhaseCost(progress, nominated ? "nominated_preparation" : "prefix_preparation", preparation, () => {
      const prepared = prepareSourceSemanticLibraryInputs(runtime, payload, authorized, preparation, request, status, query,
        { sources: records, pages: pool.sourcePages, open: pool.access.unvisited_sources, truncated: pool.access.unvisited_sources },
        { descriptors: pool.descriptors, interpretationPages: pool.interpretationPages,
          interpretationOpen: pool.access.unvisited_interpretations, interpretationTruncated: pool.access.unvisited_interpretations, pool },
        branches, request.original_query!, requestIdentity, publicIdentity, nominated ? nominations : undefined);
      if (prepared.incomplete) throw new SourceSemanticResourceExhausted("research frozen package preparation");
      return { prepared, preparation };
    });
  };
  const prefix = capture(false);
  const prefixO1 = partial.hydration.prefix = measureArm(runtime, payload, request, prefix, "O1", "field", undefined, progress, "prefix");
  const nominated = capture(true);
  const nominatedO1 = partial.hydration.nominated = partial.ordering.o1 =
    measureArm(runtime, payload, request, nominated, "O1", "field", undefined, progress, "nominated");
  // Ranking contrasts consume the SAME captured nominated repertoire and total request envelope.
  const access = partial.ordering.access = measureArm(runtime, payload, request, nominated, "access-order", "source_access", undefined, progress, "access");
  const native = partial.ordering.native = measureArm(runtime, payload, request, nominated, "native-provenance", "source_access", acquisition, progress, "native");
  return { kind: "PRIVATE_COUNTERFACTUAL" as const, query_semantics_status: status,
    hydration: { prefix: prefixO1, nominated: nominatedO1 }, ordering: { o1: nominatedO1, access, native } };
  });
}

function measureArm(runtime: Runtime, payload: SourceSemanticWorkerPayload, request: Request,
  capture: { prepared: Prepared; preparation: SourceSemanticReadBudget }, policy: string,
  order: "field" | "source_access", acquisition?: SourceSemanticAcquisitionPhase,
  progress?: DeliveryProgress, phase: CostPhase = "prefix") {
  const meter = forkCapturedRequestBudget(request, capture.preparation);
  return retainPhaseCost(progress, phase, meter, () => {
  const proposals = acquisition === undefined ? undefined : projectResearchNativeProposals(capture.prepared.packages, acquisition, meter);
  const selection = new SourceSemanticReadBudget({ work_units: Math.floor(meter.work / 2), memory_bytes: Math.floor(meter.bytes / 2) });
  let plan: ReturnType<typeof prepareLibraryDelivery>;
  try { plan = prepareLibraryDelivery(capture.prepared.base, capture.prepared.packages, request, selection, order,
    proposals === undefined ? selectSourceSemanticLibraryPage : researchNativeProposalSelector(proposals), capture.prepared.execution); }
  finally { meter.absorb(selection); }
  const result = deliverFrozenLibraryPage(runtime, payload, meter, request, plan, 0);
  const encoded = encodeSourceSemanticLibraryResponse(result);
  if (encoded.operation !== "recall" || encoded.index === undefined) {
    throw new CoreError("OBLIGATION_VIOLATION", "research fit envelope lost its recall index");
  }
  // Never return a routable MCP/native response claiming the production enumeration policy.
  // Fit still uses the unchanged FULL encoder above, including reservations and metadata.
  const { operation: _operation, order: _order, delivery_id: _delivery, request_identity: _request,
    protocol_version: _protocol, index, ...content } = encoded;
  const { continuation: _continuation, ...privateIndex } = index;
  const artifact = { ...content, index: privateIndex, frozen_plan_has_more: index.continuation !== null };
  return { kind: "PRIVATE_COUNTERFACTUAL" as const, policy, proposals,
    full_envelope_bytes: Buffer.byteLength(JSON.stringify(encoded)), output_byte_limit: request.output_byte_limit,
    fit_template: "unchanged native full envelope; not an executed evidence_support ranking claim" as const,
    artifact, package_repertoire: capture.prepared.packages.map(row => ({ target: row.entry.target, proofs: row.proofs })),
    frozen_pages: plan.pages.map(page => page.map(row => ({ target: row.entry.target, preview: row.preview, proofs: row.proofs }))) };
  });
}

/** Replay the captured call's phases as well as its costs, not a new native-only execution. */
export function forkCapturedRequestBudget(request: Request, captured: SourceSemanticReadBudget): SourceSemanticReadBudget {
  const meter = new SourceSemanticReadBudget(request.budget);
  meter.absorb(captured);
  meter.preparation = captured.preparation; meter.acquisition = captured.acquisition;
  return meter;
}

function packageRoot(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new CoreError("CONFLICT", "research library package lost source root");
  return sourceGoldRootIdentity(row.entry.target);
}
