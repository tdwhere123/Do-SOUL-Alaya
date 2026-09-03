import {
  capabilitiesAreCompatible,
  lookupExtractionCapability
} from "../../cache/semantic-artifact/capability.js";
import { inspectSemanticArtifact, recordSourceBinding } from
  "../../cache/semantic-artifact/store.js";
import { inspectCurrentOrReplayDerived } from
  "../../cache/semantic-artifact/derived-replay.js";
import {
  assertSemanticAdmissionIdentity,
  assertSemanticArtifactCompatibility
} from "../../cache/semantic-artifact/admission-identity.js";
import { captureOfflineSemanticEnvelope } from "../semantic-fill-envelope.js";
import { readSemanticFillAttemptEvidence } from "../semantic-fill-attempt-ledger.js";
import {
  runSemanticFill,
  type SemanticFillEnvelope,
  type SemanticFillReport,
  type SemanticFillTask,
  type SemanticFillTransport
} from "../semantic-fill-executor.js";

export type CapabilityFulfillmentState =
  | "cache-hit"
  | "materialized-now"
  | "unavailable"
  | "failed";

export interface CapabilityFulfillment {
  readonly state: CapabilityFulfillmentState;
  readonly semanticKey: string;
  readonly capability: string;
  readonly reason?: string;
  readonly calls: number;
  readonly sourceCorpusIdentity: string;
  readonly sourceAuthority: SemanticFillTask["sourceAuthority"];
  readonly runClosure?: Readonly<{
    startingCacheIdentity: string;
    endingCacheIdentity: string;
    startingOverlayIdentity: string;
    endingOverlayIdentity: string;
    receiptHandle: import("../semantic-fill-receipt.js").VerifiedLazySemanticRunReceipt;
  }>;
}

type FulfillmentInput = Readonly<{
  root: string;
  task: SemanticFillTask;
  envelope: SemanticFillEnvelope;
  transport?: SemanticFillTransport;
  signal?: AbortSignal;
}>;

export async function fulfillAssertionCapability(
  input: FulfillmentInput
): Promise<CapabilityFulfillment> {
  const captured = captureFulfillmentInput(input);
  captured.signal?.throwIfAborted();
  assertSemanticAdmissionIdentity(captured.task);
  const contract = lookupExtractionCapability(captured.task.capability);
  if (contract === undefined) {
    return unavailable(captured, "unknown extraction capability");
  }
  if (contract.materializer === null) {
    return unavailable(captured, "capability has no local materializer");
  }
  if (!requirementsAreAvailable(captured.root, captured.task, contract.requirements)) {
    return unavailable(captured, "capability requirements unavailable");
  }
  const existing = inspectCurrentOrReplayDerived(captured.root, captured.task);
  if ((existing.status === "provider_backed") &&
      existing.artifact !== undefined) {
    try {
      assertSemanticArtifactCompatibility(captured.task, existing.artifact, false);
    } catch (cause) {
      return unavailable(captured, cause instanceof Error ? cause.message : String(cause));
    }
    captured.signal?.throwIfAborted();
    recordSourceBinding(
      captured.root, captured.task.semanticKey, captured.task.capability, captured.task.binding
    );
    return resultFor(captured, "cache-hit", 0);
  }
  if (existing.status === "quarantined") {
    return unavailable(captured, existing.reason ?? "quarantined provider result");
  }
  if (captured.transport === undefined) return unavailable(captured, existing.status);
  const durableCallsBefore = readSemanticFillAttemptEvidence(captured.root).length;
  const report = await runSemanticFill({
    root: captured.root,
    tasks: [captured.task],
    envelope: captured.envelope,
    transport: captured.transport,
    ...(captured.signal === undefined ? {} : { signal: captured.signal })
  });
  captured.signal?.throwIfAborted();
  assertReportMatchesCapturedDemand(report, captured);
  const invocationCalls = readSemanticFillAttemptEvidence(captured.root).length - durableCallsBefore;
  if (report.admitted === 1) {
    const admitted = inspectSemanticArtifact(
      captured.root, captured.task.semanticKey, captured.task.capability
    );
    if (admitted.artifact === undefined) {
      throw new Error("capability fulfillment admission is not readable from the captured root");
    }
    assertSemanticArtifactCompatibility(captured.task, admitted.artifact);
    return resultFor(captured, "materialized-now", invocationCalls, undefined, report);
  }
  if (report.failures > 0) {
    return resultFor(
      captured, "failed", invocationCalls, report.attempts[0]?.reason, report
    );
  }
  return unavailable(
    captured, report.attempts[0]?.reason ?? "unresolved", invocationCalls, report
  );
}

function captureFulfillmentInput(input: FulfillmentInput): FulfillmentInput {
  const captureData = {
    root: input.root,
    task: input.task,
    envelope: input.envelope,
    transport: input.transport,
    signal: input.signal
  };
  const data = structuredClone({
    root: captureData.root,
    task: captureData.task,
    envelope: captureData.envelope
  }) as Pick<FulfillmentInput, "root" | "task" | "envelope">;
  const envelope = captureOfflineSemanticEnvelope(data.envelope);
  return Object.freeze({
    root: data.root,
    task: Object.freeze(data.task),
    envelope,
    ...(captureData.transport === undefined ? {} : { transport: captureData.transport }),
    ...(captureData.signal === undefined ? {} : { signal: captureData.signal })
  });
}

function assertReportMatchesCapturedDemand(
  report: SemanticFillReport,
  captured: FulfillmentInput
): void {
  const matches = (item: { readonly semanticKey: string; readonly capability: string }) =>
    item.semanticKey === captured.task.semanticKey &&
    item.capability === captured.task.capability;
  if (report.attempts.length !== 1 || !report.attempts.every(matches) ||
      report.lazyRunReceipt.demandUnits.length !== 1 ||
      !report.lazyRunReceipt.demandUnits.every(matches) ||
      (report.admitted === 1 && report.attempts[0]?.outcome !== "admitted") ||
      report.admitted > 1) {
    throw new Error("capability fulfillment report changed captured semantic demand identity");
  }
}

function unavailable(
  input: FulfillmentInput,
  reason: string,
  calls = 0,
  report?: SemanticFillReport
): CapabilityFulfillment {
  return resultFor(input, "unavailable", calls, reason, report);
}

function resultFor(
  input: FulfillmentInput,
  state: CapabilityFulfillmentState,
  calls: number,
  reason?: string,
  report?: SemanticFillReport
): CapabilityFulfillment {
  return Object.freeze({
    state,
    semanticKey: input.task.semanticKey,
    capability: input.task.capability,
    sourceCorpusIdentity: input.task.binding.sourceCorpusIdentity,
    sourceAuthority: input.task.sourceAuthority,
    ...(reason === undefined ? {} : { reason }),
    calls,
    ...(report === undefined ? {} : { runClosure: Object.freeze({
      startingCacheIdentity: report.lazyRunReceipt.startingCacheIdentity,
      endingCacheIdentity: report.lazyRunReceipt.endingCacheIdentity,
      startingOverlayIdentity: report.lazyRunReceipt.startingOverlayIdentity,
      endingOverlayIdentity: report.lazyRunReceipt.endingOverlayIdentity,
      receiptHandle: report.lazyRunReceiptHandle
    }) })
  });
}

function requirementsAreAvailable(
  root: string,
  task: SemanticFillTask,
  requirements: readonly string[]
): boolean {
  const available = requirements.filter((capability) => {
    const inspected = inspectSemanticArtifact(root, task.semanticKey, capability);
    if ((inspected.status !== "provider_backed") ||
        inspected.artifact === undefined) return false;
    try {
      assertSemanticArtifactCompatibility({ ...task, capability }, inspected.artifact, false);
      return true;
    } catch {
      return false;
    }
  });
  return capabilitiesAreCompatible(requirements, available);
}
