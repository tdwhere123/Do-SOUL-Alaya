import {
  officialApiSemanticWorksetFromUnits,
  planOfficialApiTransport,
  type TransportPack
} from "@do-soul/alaya-soul";
import { toWorkUnit } from "./semantic-fill-plan.js";
export type SemanticTransportPolicy = Parameters<typeof planOfficialApiTransport>[1];
import { createHash } from "node:crypto";
import type {
  SemanticFillEnvelope,
  SemanticFillTask,
  SemanticFillTransport,
  SemanticFillTransportResult
} from "./semantic-fill-executor.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "../cache/semantic-artifact/replay-authority.js";

interface BoundReplayResult {
  readonly executionIdentity: string;
  readonly result: SemanticFillTransportResult;
}

const replayDescriptors = new WeakMap<object, Readonly<{
  results: ReadonlyMap<string, BoundReplayResult>;
  replayAuthority: VerifiedSemanticReplayAuthority;
  afterPack?: (packId: string) => void;
  defaultResult?: Exclude<SemanticFillTransportResult, { readonly kind: "raw" }>;
}>>();

export function createOfflineSemanticReplay(input: Readonly<{
  results?: readonly Readonly<{
    packId: string;
    tasks: readonly SemanticFillTask[];
    result: SemanticFillTransportResult;
  }>[];
  defaultResult?: Exclude<SemanticFillTransportResult, { readonly kind: "raw" }>;
  faultHooks?: Readonly<{ readonly afterPack?: (packId: string) => void }>;
}>): SemanticFillTransport {
  assertExactKeys(input, ["defaultResult", "faultHooks", "results"],
    "offline semantic replay descriptor");
  const replayAuthority = currentSemanticReplayAuthority();
  const replayIdentity = unwrapSemanticReplayAuthority(replayAuthority);
  const defaultResult = input.defaultResult;
  const afterPack = input.faultHooks?.afterPack;
  if ((defaultResult as SemanticFillTransportResult | undefined)?.kind === "raw") {
    throw new Error("successful offline replay requires a physical request identity");
  }
  const results = new Map<string, BoundReplayResult>();
  for (const entry of input.results ?? []) {
    if (!/^[a-f0-9]{64}$/u.test(entry.packId) || results.has(entry.packId)) {
      throw new Error("offline semantic replay descriptor has an invalid pack identity");
    }
    results.set(entry.packId, Object.freeze({
      executionIdentity: replayExecutionIdentity(
        entry.packId, entry.tasks, entry.result, replayIdentity
      ),
      result: freezeResult(entry.result)
    }));
  }
  const transport = Object.freeze({ kind: "sealed-local-replay" as const });
  replayDescriptors.set(transport, Object.freeze({
    results,
    replayAuthority,
    ...(afterPack === undefined ? {} : { afterPack }),
    ...(defaultResult === undefined ? {} : { defaultResult: freezeResult(defaultResult) })
  }));
  return transport;
}

export function createOfflineSemanticReplayForTasks(input: Readonly<{
  tasks: readonly SemanticFillTask[];
  transportPolicy: SemanticTransportPolicy;
  result: SemanticFillTransportResult;
}>): SemanticFillTransport {
  assertExactKeys(input, ["result", "tasks", "transportPolicy"],
    "offline semantic task replay descriptor");
  const byCorpus = new Map<string, SemanticFillTask[]>();
  for (const task of input.tasks) {
    const group = byCorpus.get(task.binding.sourceCorpusIdentity) ?? [];
    group.push(task);
    byCorpus.set(task.binding.sourceCorpusIdentity, group);
  }
  const results: Array<{
    packId: string;
    tasks: readonly SemanticFillTask[];
    result: SemanticFillTransportResult;
  }> = [];
  for (const group of byCorpus.values()) {
    const plan = planOfficialApiTransport(
      officialApiSemanticWorksetFromUnits(group.map(toWorkUnit)),
      input.transportPolicy
    );
    if (plan.unpackable.length > 0) {
      throw new Error("offline replay fixture contains unpackable semantic work");
    }
    for (const pack of plan.packs) {
      results.push({
        packId: pack.pack_id,
        tasks: pack.semantic_keys.map((key) => {
          const task = group.find((candidate) => candidate.semanticKey === key);
          if (task === undefined) throw new Error("offline replay fixture lost a semantic task");
          return task;
        }),
        result: input.result
      });
    }
  }
  return createOfflineSemanticReplay({ results });
}

export function replayOfflineSemanticPack(
  transport: SemanticFillTransport,
  pack: TransportPack,
  tasks: readonly SemanticFillTask[]
): SemanticFillTransportResult {
  const descriptor = replayDescriptors.get(transport);
  if (descriptor === undefined) {
    throw new Error("semantic fill transport is not a sealed local replay descriptor");
  }
  const bound = descriptor.results.get(pack.pack_id);
  let result: SemanticFillTransportResult;
  if (bound !== undefined) {
    result = bound.executionIdentity === replayExecutionIdentity(
      pack.pack_id, tasks, bound.result,
      unwrapSemanticReplayAuthority(descriptor.replayAuthority)
    )
      ? bound.result
      : { kind: "failure", reason: "offline replay physical request identity mismatch" };
  } else {
    result = descriptor.defaultResult ?? { kind: "failure", reason: "offline replay pack unavailable" };
  }
  descriptor.afterPack?.(pack.pack_id);
  return result;
}

export function createOfflineSemanticEnvelope(input: Readonly<{
  maxCalls: number;
  maxFailures: number;
  transportPolicy?: SemanticTransportPolicy;
}>): SemanticFillEnvelope {
  const transportPolicy: SemanticTransportPolicy = input.transportPolicy ?? {
    kind: "token_aware",
    maxAssertions: 32,
    maxInputTokens: 100_000,
    expectedOutputCap: 8_000,
    systemPromptChars: 0
  };
  return captureOfflineSemanticEnvelope({
    mode: "offline-only",
    maxCalls: input.maxCalls,
    maxFailures: input.maxFailures,
    transportPolicy
  });
}

export function captureOfflineSemanticEnvelope(
  envelope: SemanticFillEnvelope
): SemanticFillEnvelope {
  const keys = Object.keys(envelope).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "maxCalls", "maxFailures", "mode", "transportPolicy"
  ])) {
    throw new Error("offline semantic envelope contains caller-supplied execution authority");
  }
  return Object.freeze({
    mode: envelope.mode,
    maxCalls: envelope.maxCalls,
    maxFailures: envelope.maxFailures,
    transportPolicy: Object.freeze({ ...envelope.transportPolicy })
  });
}

export function assertOfflineSemanticExecution(
  envelope: SemanticFillEnvelope,
  transport: SemanticFillTransport
): void {
  if (envelope.mode !== "offline-only") {
    throw new Error("semantic fill requires the offline-only envelope");
  }
  assertSafeBudget(envelope.maxCalls, "maxCalls");
  assertSafeBudget(envelope.maxFailures, "maxFailures");
  assertTransportPolicy(envelope.transportPolicy);
  const descriptor = replayDescriptors.get(transport);
  if (descriptor === undefined) {
    throw new Error("semantic fill transport is not a sealed local replay descriptor");
  }
  unwrapSemanticReplayAuthority(descriptor.replayAuthority);
}

export function semanticReplayAuthorityForTransport(
  transport: SemanticFillTransport
): VerifiedSemanticReplayAuthority {
  const descriptor = replayDescriptors.get(transport);
  if (descriptor === undefined) {
    throw new Error("semantic fill transport is not a sealed local replay descriptor");
  }
  unwrapSemanticReplayAuthority(descriptor.replayAuthority);
  return descriptor.replayAuthority;
}

export function assertSafeBudget(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite safe nonnegative integer`);
  }
}

function assertTransportPolicy(policy: SemanticTransportPolicy): void {
  if (policy.kind === "reference_batch_8") return;
  if (policy.kind === "reference_batch") {
    if (![8, 16, 24, 32].includes(policy.assertionsPerPack)) {
      throw new Error("reference transport policy is invalid");
    }
    return;
  }
  for (const [label, value] of Object.entries({
    maxAssertions: policy.maxAssertions,
    maxInputTokens: policy.maxInputTokens,
    expectedOutputCap: policy.expectedOutputCap,
    systemPromptChars: policy.systemPromptChars
  })) assertSafeBudget(value, label);
  if (policy.maxAssertions === 0 || policy.maxInputTokens === 0 ||
      policy.expectedOutputCap === 0) {
    throw new Error("token-aware transport hard caps must be positive");
  }
}

function replayExecutionIdentity(
  packId: string,
  tasks: readonly SemanticFillTask[],
  result: SemanticFillTransportResult,
  replayIdentity: ReturnType<typeof unwrapSemanticReplayAuthority>
): string {
  const rawResponseDigest = result.kind === "raw"
    ? createHash("sha256").update(result.rawJson, "utf8").digest("hex")
    : null;
  const authority = tasks[0]?.sourceAuthority;
  const manifest = authority?.substrateManifest;
  return createHash("sha256").update(JSON.stringify({
    raw_response_digest: rawResponseDigest,
    replay_identity_digest: semanticReplayIdentityDigest(replayIdentity),
    pack_id: packId,
    source_corpus_identity: tasks[0]?.binding.sourceCorpusIdentity,
    source_authority: authority === undefined || manifest === undefined ? null : {
      datasetRevision: authority.datasetRevision,
      substrateCacheKeys: [...authority.substrateCacheKeys],
      substrateManifest: {
        schemaVersion: manifest.schemaVersion,
        manifestSha256: manifest.manifestSha256,
        dataset: manifest.dataset,
        datasetRevision: manifest.datasetRevision,
        extractionModel: manifest.extractionModel,
        modelFamily: manifest.modelFamily,
        requestProfile: manifest.requestProfile,
        systemPromptSha256: manifest.systemPromptSha256,
        cacheKeyAlgorithm: manifest.cacheKeyAlgorithm,
        expectedTurns: manifest.expectedTurns,
        expectedKeySetSha256: manifest.expectedKeySetSha256,
        contentClosureSha256: manifest.contentClosureSha256,
        contentClosureIndexSha256: manifest.contentClosureIndexSha256,
        windowOffset: manifest.windowOffset,
        windowLimit: manifest.windowLimit
      }
    },
    members: tasks.map((task) => ({
      semantic_key: task.semanticKey,
      capability: task.capability,
      assertion_id: task.assertionId,
      exact_text: task.text,
      semantic_contract: task.semanticContract,
      model_family: task.modelFamily,
      model_id: task.modelId,
      transport_model_id: task.transportModelId,
      request_profile: task.requestProfile,
      provider_url_sha256: task.providerUrlSha256,
      assertion_semantic_contract: task.semanticIdentity.contractId
    }))
  }), "utf8").digest("hex");
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains caller-supplied execution authority`);
  }
}

function freezeResult<T extends SemanticFillTransportResult>(result: T): T {
  if (result.kind === "raw") {
    return Object.freeze({ kind: result.kind, rawJson: result.rawJson }) as T;
  }
  return Object.freeze({ kind: result.kind, reason: result.reason }) as T;
}
