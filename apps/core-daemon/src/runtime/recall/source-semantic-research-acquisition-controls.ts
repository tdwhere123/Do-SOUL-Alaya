import { unavailableSourceQueryPreparation, type SourceSemanticQueryPreparation } from "@do-soul/alaya-protocol";
import { CoreError, SourceIndexAcquisition } from "@do-soul/alaya-core";
import type { RecallReadWorkerClient } from "./recall-read-worker-client.js";
import { SourceSemanticsPublicPayloadSchema, type SourceSemanticsPublicPayload } from "../recall-read-worker/operation-schemas.js";
import type { ResearchSourceAcquisitionReply } from "../recall-read-worker/source-semantic-research-nominated-library.js";

import { QualifiedSourceSelectionSchema, type QualifiedSourceSelection, type QualifiedSourceSelectionReply }
  from "../recall-read-worker/source-semantic-qualified-selection-boundary.js";
import { SourceSemanticJointSelectionSchema } from "../recall-read-worker/source-semantic-joint-boundary.js";
import type { SourceSemanticJointSelection } from "@do-soul/alaya-core/dist/recall/conditional-field/query/source-semantic-joint-witness.js";

type QualifiedComparisonFailure = { phase: "begin" | "selection" | "cleanup"; cause: unknown; earlier?: QualifiedComparisonFailure };
type PreparedQuery = NonNullable<Parameters<NonNullable<RecallReadWorkerClient["researchAcquisition"]>["dispatch"]>[1]>;
type ChannelControl = "lexical" | "vector" | "dual";
type NotCompletedArm = Readonly<{ kind: "not_completed" }>;
type CompletedArm = ReturnType<typeof projectArm>;
type ArmEnvelope = CompletedArm | NotCompletedArm;
type Failure = Readonly<{ phase: "prepare" | "begin" | "lexical" | "vector" | "dual" | "cleanup"; cause: unknown; earlier?: Failure }>;
type Physical = ReturnType<typeof physicalFromPrepared> | ReturnType<typeof physicalUnknown>;
type ComparisonBase = Readonly<{
  kind: "PRIVATE_COUNTERFACTUAL"; physical_prepare_once: Physical;
  arm_envelopes: Readonly<{ lexical: ArmEnvelope; vector: ArmEnvelope; dual: ArmEnvelope }>;
  cleanup?: Readonly<{ rollback: "failed" | "unknown"; worker_reusable: false }>;
}>;
type Comparison =
  | (ComparisonBase & Readonly<{ outcome: "complete" }>)
  | (ComparisonBase & Readonly<{ outcome: "unavailable"; failure?: Failure }>)
  | (ComparisonBase & Readonly<{ outcome: "partial"; failure: Failure }>)
  | (ComparisonBase & Readonly<{ outcome: "failed"; failure: Failure }>);

/** Adapter-needed capability only. Not the worker client, raw DB, or a public runtime property. */
export type ResearchSourceAcquisitionPort = Pick<RecallReadWorkerClient, "researchAcquisition" | "researchLibrary" | "readSnapshot">;

const hosts = new WeakMap<object, ResearchSourceAcquisitionPort>();
const NOT_COMPLETED: NotCompletedArm = { kind: "not_completed" };
const NOT_COMPLETED_ARMS = { lexical: NOT_COMPLETED, vector: NOT_COMPLETED, dual: NOT_COMPLETED } as const;

/**
 * Named consumer: createAlayaDaemonRuntime. Routes the already-wired producer client; not readiness.
 * Removal: when compareResearchSourceAcquisitionControls is deleted or publicly promoted.
 */
export function bindResearchSourceAcquisitionClient(runtime: object, client: ResearchSourceAcquisitionPort): void {
  if (hosts.has(runtime)) throw new CoreError("CONFLICT", "research acquisition client already bound");
  if (client.researchAcquisition === undefined || client.readSnapshot.isolate === undefined) {
    throw new CoreError("CONFLICT", "research acquisition controls require the native worker client");
  }
  hosts.set(runtime, { researchAcquisition: client.researchAcquisition, researchLibrary: client.researchLibrary, readSnapshot: client.readSnapshot });
}

/**
 * Named consumer: compareSemanticChainSourceAcquisition.
 * Removal: same gate as bindResearchSourceAcquisitionClient.
 */
export function researchSourceAcquisitionClient(runtime: object): ResearchSourceAcquisitionPort {
  const client = hosts.get(runtime);
  if (client === undefined) throw new CoreError("CONFLICT", "research acquisition client is not bound");
  return client;
}

/**
 * Named bench consumer: compareSemanticChainSourceAcquisition. One physical prepare, one worker, one read snapshot,
 * three counterfactual arms. Not MCP, ranking, nominated hydration, or a second recall pipeline.
 */
export async function compareResearchSourceAcquisitionControls(
  client: ResearchSourceAcquisitionPort, input: SourceSemanticsPublicPayload,
  options?: Readonly<{ signal?: AbortSignal; timeoutMs: number }>
) {
  const captured = structuredClone(input);
  const host = client.researchAcquisition, snapshot = client.readSnapshot;
  if (host === undefined || snapshot.isolate === undefined) {
    throw new CoreError("CONFLICT", "research acquisition controls require the native worker client");
  }
  let retained: Comparison | undefined;
  let progress: ComparisonBase | undefined;
  let activePhase: Failure["phase"] = "prepare";
  try {
    const run = () => snapshot.isolate!(async () => {
      const result = await runComparison(host, snapshot, captured, (value, phase) => { progress = value; activePhase = phase; });
      retained = result;
      return result;
    });
    const comparison = options === undefined ? await run() : await host.withExecutionScope(options, run);
    return comparison;
  } catch (error) {
    if (retained !== undefined) return withCleanupFailure(retained, error, "unknown");
    if (options !== undefined) return {
      ...(progress ?? { kind: "PRIVATE_COUNTERFACTUAL", physical_prepare_once: physicalUnknown(error), arm_envelopes: NOT_COMPLETED_ARMS }),
      outcome: progress === undefined ? "failed" : "partial", failure: { phase: activePhase, cause: error },
      cleanup: { rollback: "unknown", worker_reusable: false }
    } as Comparison;
    throw error;
  }
}

/** Guarded Bench's Q-present mode. No query/vector preparation, even on unavailable inputs.
 * Retain a completed worker result before rollback or execution-scope cleanup can fail. */
export async function compareResearchSourceQualifiedSelection(client: ResearchSourceAcquisitionPort,
  input: SourceSemanticsPublicPayload, population: QualifiedSourceSelection,
  options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>, jointSelection?: SourceSemanticJointSelection) {
  const captured = SourceSemanticsPublicPayloadSchema.parse(structuredClone(input));
  const fixed = QualifiedSourceSelectionSchema.parse(structuredClone(population));
  const joint = jointSelection === undefined ? undefined : SourceSemanticJointSelectionSchema.parse(structuredClone(jointSelection));
  const host = client.researchLibrary, scope = client.researchAcquisition, snapshot = client.readSnapshot;
  if (host === undefined || scope === undefined || snapshot.isolate === undefined) {
    throw new CoreError("CONFLICT", "qualified comparison requires the native library worker");
  }
  let selection: QualifiedSourceSelectionReply | undefined, failure: QualifiedComparisonFailure | undefined;
  let phase: QualifiedComparisonFailure["phase"] = "begin";
  try {
    await scope.withExecutionScope(options, () => snapshot.isolate!(async () => {
      try {
        await snapshot.beginDeferred(); phase = "selection";
        selection = await host.compareQualified(captured, fixed, joint);
      } catch (cause) { failure = { phase, cause }; }
      phase = "cleanup";
      try { await snapshot.rollback(); }
      catch (cause) { failure = { phase, cause, ...(failure === undefined ? {} : { earlier: failure }) }; }
    }));
  } catch (cause) { failure = { phase, cause, ...(failure === undefined ? {} : { earlier: failure }) }; }
  return { kind: "PRIVATE_QUALIFIED_SELECTION" as const, outcome: failure === undefined ? selection!.status : "failed" as const,
    selection, ...(failure === undefined ? {} : { failure }) };
}

async function runComparison(
  host: NonNullable<ResearchSourceAcquisitionPort["researchAcquisition"]>,
  snapshot: ResearchSourceAcquisitionPort["readSnapshot"],
  captured: SourceSemanticsPublicPayload,
  checkpoint: (value: ComparisonBase, phase: Failure["phase"]) => void
): Promise<Comparison> {
  let prepared: PreparedQuery | undefined;
  try { prepared = structuredClone(await host.prepareQuery(captured)); }
  catch (error) {
    const attached = preparedFromThrown(error);
    return {
      kind: "PRIVATE_COUNTERFACTUAL", outcome: "failed",
      physical_prepare_once: attached === undefined ? physicalUnknown(error) : physicalFromPrepared(attached),
      arm_envelopes: NOT_COMPLETED_ARMS, failure: { phase: "prepare", cause: error }
    };
  }
  const physical = physicalFromPrepared(prepared);
  checkpoint({ kind: "PRIVATE_COUNTERFACTUAL", physical_prepare_once: physical, arm_envelopes: NOT_COMPLETED_ARMS }, "begin");
  if (prepared.vector.status !== "available" || prepared.receipt.status !== "ready") {
    return {
      kind: "PRIVATE_COUNTERFACTUAL", outcome: "unavailable",
      physical_prepare_once: physical, arm_envelopes: NOT_COMPLETED_ARMS
    };
  }
  let begun = false;
  let result: Comparison | undefined;
  const arms: { lexical?: CompletedArm; vector?: CompletedArm; dual?: CompletedArm } = {};
  try {
    try { await snapshot.beginDeferred(); }
    catch (error) {
      // Host snapshotBegun is set before worker ack. Unwind through the existing rollback
      // owner without replacing the begin cause if rollback itself fails.
      try { await snapshot.rollback(); } catch { /* original begin cause owns the throw */ }
      return {
        kind: "PRIVATE_COUNTERFACTUAL", outcome: "failed",
        physical_prepare_once: physical, arm_envelopes: NOT_COMPLETED_ARMS,
        failure: { phase: "begin", cause: error }
      };
    }
    begun = true;
    try {
      const lexicalPrepared: PreparedQuery = {
        receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
        vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested }
      };
      checkpoint({ kind: "PRIVATE_COUNTERFACTUAL", physical_prepare_once: physical, arm_envelopes: NOT_COMPLETED_ARMS }, "lexical");
      arms.lexical = projectArm(await host.dispatch(captured, lexicalPrepared, "lexical"), "lexical");
      checkpoint({ kind: "PRIVATE_COUNTERFACTUAL", physical_prepare_once: physical,
        arm_envelopes: { lexical: arms.lexical, vector: NOT_COMPLETED, dual: NOT_COMPLETED } }, "vector");
      arms.vector = projectArm(await host.dispatch(captured, structuredClone(prepared), "vector"), "vector");
      checkpoint({ kind: "PRIVATE_COUNTERFACTUAL", physical_prepare_once: physical,
        arm_envelopes: { lexical: arms.lexical, vector: arms.vector, dual: NOT_COMPLETED } }, "dual");
      arms.dual = projectArm(await host.dispatch(captured, structuredClone(prepared), "dual"), "dual");
      result = {
        kind: "PRIVATE_COUNTERFACTUAL", outcome: "complete",
        physical_prepare_once: physical,
        arm_envelopes: { lexical: arms.lexical, vector: arms.vector, dual: arms.dual }
      };
    } catch (error) {
      result = {
        kind: "PRIVATE_COUNTERFACTUAL", outcome: "partial",
        physical_prepare_once: physical,
        arm_envelopes: {
          lexical: arms.lexical ?? NOT_COMPLETED, vector: arms.vector ?? NOT_COMPLETED, dual: arms.dual ?? NOT_COMPLETED
        },
        failure: { phase: arms.lexical === undefined ? "lexical" : arms.vector === undefined ? "vector" : "dual", cause: error }
      };
    }
  } finally {
    if (begun) {
      try { await snapshot.rollback(); }
      catch (cleanupError) {
        result = withCleanupFailure(result!, cleanupError, "failed");
      }
    }
  }
  return result!;
}

function withCleanupFailure(result: Comparison, cleanupError: unknown, rollback: "failed" | "unknown"): Comparison {
  const cleanup = { rollback, worker_reusable: false as const };
  if (result.outcome === "complete") {
    return { ...result, outcome: "failed", cleanup, failure: { phase: "cleanup", cause: cleanupError } };
  }
  if (result.outcome === "unavailable") {
    return { ...result, cleanup, failure: { phase: "cleanup", cause: cleanupError } };
  }
  return {
    ...result, cleanup,
    failure: { phase: "cleanup", cause: cleanupError, earlier: result.failure }
  };
}

function preparedFromThrown(error: unknown): PreparedQuery | undefined {
  if (typeof error !== "object" || error === null || !("researchPreparedQuery" in error)) return undefined;
  return error.researchPreparedQuery as PreparedQuery;
}

function physicalFromPrepared(prepared: PreparedQuery) {
  const receipt: SourceSemanticQueryPreparation = prepared.receipt;
  return {
    receipt,
    submitted_inputs: receipt.submitted_inputs === null ? "unknown" as const : receipt.submitted_inputs,
    elapsed_ms: receipt.elapsed_ms === null ? "unknown" as const : receipt.elapsed_ms,
    attributed_to: ["vector", "dual"] as const
  };
}

function physicalUnknown(cause: unknown) {
  return {
    receipt: null,
    submitted_inputs: "unknown" as const,
    elapsed_ms: "unknown" as const,
    attributed_to: [] as const,
    cause
  };
}

function projectArm(reply: ResearchSourceAcquisitionReply, control: ChannelControl) {
  const result = reply.result;
  // Same private-counterfactual stripping as nominated-library compare: drop routable delivery identities.
  const { delivery_id: _delivery, request_identity: _request, protocol_version: _protocol, order: _order,
    index, ...content } = result;
  const { continuation: _continuation, ...privateIndex } = index;
  return {
    kind: "PRIVATE_COUNTERFACTUAL" as const,
    control,
    request_budget: result.request_budget ?? null,
    work: result.work,
    execution: result.execution,
    full_envelope_bytes: Buffer.byteLength(JSON.stringify(result)),
    // Costs remain cumulative fork quotes (including their shared baseline), not additive physical work.
    private_delivery: reply.private_delivery,
    artifact: { ...content, index: privateIndex, frozen_plan_has_more: index.continuation !== null }
  };
}
