import { createHash } from "node:crypto";
import { parseOfficialApiSignals } from "@do-soul/alaya-soul";
import {
  capabilitiesAreCompatible,
  resolveExtractionCapability
} from "./capability.js";
import {
  sealSemanticArtifact,
  type SemanticArtifact,
  type SemanticArtifactSourceBinding
} from "./contract.js";
import { inspectSemanticArtifact, persistRawArtifact, readPersistedRawArtifact } from "./store.js";
import {
  assertSemanticAdmissionIdentity,
  assertSemanticArtifactCompatibility,
  type SemanticAdmissionIdentity
} from "./admission-identity.js";
import {
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "./replay-authority.js";
import { resolveExactSourceGrounding } from "./exact-source-grounding.js";
import { unwrapLegacySemanticArtifactAdmission } from "./legacy-admission-authority.js";

export interface AdmissionTask extends SemanticAdmissionIdentity {
  readonly binding: SemanticArtifactSourceBinding;
  readonly sourceAuthority: import("../../fill/semantic-fill-authority.js").SemanticTaskSourceAuthority;
}

export interface VerifiedSemanticArtifactAdmission {
  readonly semanticKey: string;
  readonly state: "provider_backed" | "quarantined";
}

const verifiedAdmissions = new WeakMap<object, SemanticArtifact>();

export type RawAdmission =
  | { readonly kind: "provider_backed"; readonly admission: VerifiedSemanticArtifactAdmission; readonly semanticKey: string }
  | { readonly kind: "quarantined"; readonly admission: VerifiedSemanticArtifactAdmission; readonly semanticKey: string }
  | { readonly kind: "unresolved"; readonly reason: string; readonly semanticKey: string };

export function unwrapVerifiedSemanticArtifactAdmission(
  handle: VerifiedSemanticArtifactAdmission
): SemanticArtifact {
  const artifact = verifiedAdmissions.get(handle) ??
    unwrapLegacySemanticArtifactAdmission(handle);
  if (artifact === undefined || artifact.semantic_key !== handle.semanticKey ||
      artifact.admission_state !== handle.state) {
    throw new Error("semantic artifact publication requires a verified admission handle");
  }
  return artifact;
}

function captureAdmission(artifact: SemanticArtifact): VerifiedSemanticArtifactAdmission {
  if (artifact.admission_state !== "provider_backed" && artifact.admission_state !== "quarantined") {
    throw new Error("raw admission cannot verify this artifact state");
  }
  const handle = Object.freeze({
    semanticKey: artifact.semantic_key,
    state: artifact.admission_state
  });
  verifiedAdmissions.set(handle, artifact);
  return handle;
}

export function admitProviderRaw(input: {
  readonly root: string;
  readonly rawJson: string;
  readonly tasks: readonly AdmissionTask[];
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly rawBinding: Readonly<{
    packIdentity: string;
    requestSha256: string;
    sourceCorpusIdentity: string;
    policyKind: "reference_batch" | "reference_batch_8" | "token_aware";
  }>;
}): readonly RawAdmission[] {
  const replayIdentity = unwrapSemanticReplayAuthority(input.replayAuthority);
  const replayIdentityDigest = semanticReplayIdentityDigest(replayIdentity);
  const identityFailure = validateAdmissionTasks(input.tasks, input.rawBinding);
  if (identityFailure !== undefined) {
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: identityFailure,
      semanticKey: task.semanticKey
    }));
  }
  const digest = digestCanonicalRaw(input.rawJson);
  if (digest.kind === "unresolved") {
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: digest.reason,
      semanticKey: task.semanticKey
    }));
  }
  persistRawArtifact(input.root, input.rawJson);
  let drafts: ReturnType<typeof parseOfficialApiSignals>;
  try {
    drafts = parseOfficialApiSignals(input.rawJson);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return input.tasks.map((task) => ({
      kind: "unresolved",
      reason: `parser drop: ${reason}`,
      semanticKey: task.semanticKey
    }));
  }
  if (drafts.length === 0) {
    return input.tasks.map((task) => emptyBatchQuarantine(
      task, replayIdentity, replayIdentityDigest, digest.sha256
    ));
  }
  return admitParsedProviderDrafts({
    root: input.root,
    tasks: input.tasks,
    drafts,
    rawDigest: digest.sha256,
    rawBinding: input.rawBinding,
    replayAuthority: input.replayAuthority
  });
}

export function admitDerivedReplayFromRaw(input: {
  readonly root: string;
  readonly task: AdmissionTask;
  readonly existing: SemanticArtifact;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
}): RawAdmission {
  const rawDigest = input.existing.raw_response_digest;
  if (rawDigest === undefined) {
    return {
      kind: "unresolved",
      reason: "derived replay requires persisted raw evidence",
      semanticKey: input.task.semanticKey
    };
  }
  let rawJson: string;
  try {
    rawJson = readPersistedRawArtifact(input.root, rawDigest);
  } catch (cause) {
    return {
      kind: "unresolved",
      reason: cause instanceof Error ? cause.message : String(cause),
      semanticKey: input.task.semanticKey
    };
  }
  const digest = digestCanonicalRaw(rawJson);
  if (digest.kind === "unresolved" || digest.sha256 !== rawDigest) {
    return {
      kind: "unresolved",
      reason: digest.kind === "unresolved" ? digest.reason : "raw artifact digest mismatch",
      semanticKey: input.task.semanticKey
    };
  }
  const replayIdentity = unwrapSemanticReplayAuthority(input.replayAuthority);
  let drafts: ReturnType<typeof parseOfficialApiSignals>;
  try {
    drafts = parseOfficialApiSignals(rawJson);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "unresolved",
      reason: `parser drop: ${reason}`,
      semanticKey: input.task.semanticKey
    };
  }
  if (drafts.length === 0) {
    return emptyBatchQuarantine(
      input.task, replayIdentity, semanticReplayIdentityDigest(replayIdentity), rawDigest
    );
  }
  const rawBinding = input.existing.raw_evidence_binding;
  if (rawBinding === undefined) {
    return {
      kind: "unresolved",
      reason: "derived replay requires persisted raw evidence",
      semanticKey: input.task.semanticKey
    };
  }
  const [admission] = admitParsedProviderDrafts({
    root: input.root,
    tasks: [input.task],
    drafts,
    rawDigest,
    replayAuthority: input.replayAuthority,
    rawBinding: {
      packIdentity: rawBinding.pack_identity,
      requestSha256: rawBinding.request_sha256,
      sourceCorpusIdentity: rawBinding.source_corpus_identity,
      policyKind: "token_aware"
    }
  });
  if (admission === undefined) {
    return {
      kind: "unresolved",
      reason: "derived replay produced no admission",
      semanticKey: input.task.semanticKey
    };
  }
  return admission;
}

function emptyBatchQuarantine(
  task: AdmissionTask,
  replayIdentity: ReturnType<typeof unwrapSemanticReplayAuthority>,
  replayIdentityDigest: string,
  rawDigest: string
): RawAdmission {
  return {
    kind: "quarantined",
    semanticKey: task.semanticKey,
    admission: captureAdmission(sealSemanticArtifact({
      schema_version: 1,
      kind: "assertion_semantic_artifact_v1",
      semantic_key: task.semanticKey,
      semantic_contract: task.semanticContract,
      capability: task.capability,
      capability_set: [task.capability],
      model_family: task.modelFamily,
      model_id: task.modelId,
      admission_state: "quarantined",
      source_bindings: [task.binding],
      replay_identity: replayIdentity,
      replay_identity_digest: replayIdentityDigest,
      raw_response_digest: rawDigest,
      quarantine_reason: "batch-empty is not assertion-empty without exhaustive inspection proof"
    }))
  };
}

export function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function admitParsedProviderDrafts(input: {
  readonly root: string;
  readonly tasks: readonly AdmissionTask[];
  readonly drafts: ReturnType<typeof parseOfficialApiSignals>;
  readonly rawDigest: string;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly rawBinding: Readonly<{
    packIdentity: string;
    requestSha256: string;
    sourceCorpusIdentity: string;
    policyKind: "reference_batch" | "reference_batch_8" | "token_aware";
  }>;
}): readonly RawAdmission[] {
  const claimed = new Map<number, number>();
  const byAssertion = new Map(input.tasks.map((task) => [task.assertionId, task]));
  const accepted = new Set<string>();
  const groundingFailures = new Map<number, string>();
  for (const draft of input.drafts) {
    const assertionId = readAssertionId(draft.source_locator);
    if (assertionId === undefined) continue;
    claimed.set(assertionId, (claimed.get(assertionId) ?? 0) + 1);
    if ((claimed.get(assertionId) ?? 0) > 1) {
      accepted.delete(byAssertion.get(assertionId)?.semanticKey ?? "");
      continue;
    }
    const task = byAssertion.get(assertionId);
    if (task === undefined) continue;
    const grounding = resolveExactSourceGrounding({
      task,
      sourceLocator: draft.source_locator,
      matchedText: draft.matched_text
    });
    if (grounding.status !== "grounded") {
      groundingFailures.set(assertionId, grounding.reason);
      continue;
    }
    accepted.add(task.semanticKey);
  }
  for (const [assertionId, count] of claimed) {
    if (count > 1) accepted.delete(byAssertion.get(assertionId)?.semanticKey ?? "");
  }
  return input.tasks.map((task) => admitParsedTask({
    ...input, task, claimed, accepted, groundingFailures
  }));
}

function admitParsedTask(input: {
  readonly root: string;
  readonly task: AdmissionTask;
  readonly rawDigest: string;
  readonly replayAuthority: VerifiedSemanticReplayAuthority;
  readonly rawBinding: Readonly<{
    packIdentity: string;
    requestSha256: string;
    sourceCorpusIdentity: string;
    policyKind: "reference_batch" | "reference_batch_8" | "token_aware";
  }>;
  readonly claimed: ReadonlyMap<number, number>;
  readonly accepted: ReadonlySet<string>;
  readonly groundingFailures: ReadonlyMap<number, string>;
}): RawAdmission {
  const task = input.task;
  const replayIdentity = unwrapSemanticReplayAuthority(input.replayAuthority);
  const replayIdentityDigest = semanticReplayIdentityDigest(replayIdentity);
  if (task.capability !== "official_api_signals:v1") {
    return { kind: "unresolved", reason: "parser does not produce this capability", semanticKey: task.semanticKey };
  }
  if (!input.accepted.has(task.semanticKey) || (input.claimed.get(task.assertionId) ?? 0) !== 1) {
    return {
      kind: "unresolved",
      reason: input.groundingFailures.has(task.assertionId)
        ? `grounding rejected: ${input.groundingFailures.get(task.assertionId)}`
        : "no injective in-pack signal",
      semanticKey: task.semanticKey
    };
  }
  const missing = missingCapabilityRequirements(input.root, task);
  if (missing !== undefined) return { kind: "unresolved", reason: missing, semanticKey: task.semanticKey };
  return {
    kind: "provider_backed",
    semanticKey: task.semanticKey,
    admission: captureAdmission(sealSemanticArtifact({
      schema_version: 1,
      kind: "assertion_semantic_artifact_v1",
      semantic_key: task.semanticKey,
      semantic_contract: task.semanticContract,
      capability: task.capability,
      capability_set: [task.capability],
      model_family: task.modelFamily,
      model_id: task.modelId,
      admission_state: "provider_backed",
      source_bindings: [task.binding],
      replay_identity: replayIdentity,
      replay_identity_digest: replayIdentityDigest,
      raw_response_digest: input.rawDigest,
      raw_evidence_binding: {
        pack_identity: input.rawBinding.packIdentity,
        request_sha256: input.rawBinding.requestSha256,
        source_corpus_identity: input.rawBinding.sourceCorpusIdentity,
        replay_identity_digest: replayIdentityDigest
      },
      provider_provenance: {
        provider_url_sha256: task.providerUrlSha256,
        request_profile: task.requestProfile,
        model_id: task.modelId,
        transport_model_id: task.transportModelId
      }
    }))
  };
}

function readAssertionId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const assertionId = (value as { readonly assertion_id?: unknown }).assertion_id;
  return Number.isSafeInteger(assertionId) && Number(assertionId) > 0
    ? Number(assertionId)
    : undefined;
}

function digestCanonicalRaw(
  rawJson: string
): { kind: "ok"; sha256: string } | { kind: "unresolved"; reason: string } {
  const bytes = Buffer.from(rawJson, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== rawJson) {
    return { kind: "unresolved", reason: "raw artifact UTF-8 bytes are not canonical" };
  }
  try {
    const parsed = JSON.parse(rawJson) as { signals?: unknown };
    if (!Array.isArray(parsed.signals)) {
      return { kind: "unresolved", reason: "raw artifact signals array missing" };
    }
  } catch {
    return { kind: "unresolved", reason: "raw artifact is not strict JSON" };
  }
  return { kind: "ok", sha256: createHash("sha256").update(rawJson, "utf8").digest("hex") };
}

function validateAdmissionTasks(
  tasks: readonly AdmissionTask[],
  rawBinding: Readonly<{
    packIdentity: string;
    requestSha256: string;
    sourceCorpusIdentity: string;
    policyKind: "reference_batch" | "reference_batch_8" | "token_aware";
  }>
): string | undefined {
  try {
    for (const task of tasks) assertSemanticAdmissionIdentity(task);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  if (new Set(tasks.map((task) => task.assertionId)).size !== tasks.length ||
      new Set(tasks.map((task) => task.semanticKey)).size !== tasks.length) {
    return "semantic admission request members are not injective";
  }
  const corpora = new Set(tasks.map((task) => task.binding.sourceCorpusIdentity));
  if (corpora.size > 1) {
    return "semantic admission request mixes source corpus identities";
  }
  const semanticKeys = tasks.map((task) => task.semanticKey);
  const expectedPackIdentity = createHash("sha256")
    .update("1", "utf8").update("\u0000", "utf8")
    .update(rawBinding.policyKind, "utf8").update("\u0000", "utf8")
    .update(semanticKeys.join("\n"), "utf8").digest("hex");
  const expectedRequestSha256 = createHash("sha256").update(JSON.stringify({
    pack_id: expectedPackIdentity,
    source_corpus_identity: rawBinding.sourceCorpusIdentity,
    source_authority: tasks[0]?.sourceAuthority,
    members: tasks.map((task) => ({
      semantic_key: task.semanticKey,
      assertion_id: task.assertionId,
      exact_text: task.text
    }))
  }), "utf8").digest("hex");
  if (rawBinding.packIdentity !== expectedPackIdentity ||
      rawBinding.requestSha256 !== expectedRequestSha256 ||
      !/^[a-f0-9]{64}$/u.test(rawBinding.sourceCorpusIdentity) ||
      [...corpora][0] !== rawBinding.sourceCorpusIdentity) {
    return "raw evidence binding does not match pack request and corpus identity";
  }
  return undefined;
}

function missingCapabilityRequirements(root: string, task: AdmissionTask): string | undefined {
  const contract = resolveExtractionCapability(task.capability);
  const available = contract.requirements.filter((capability) => {
    const inspected = inspectSemanticArtifact(root, task.semanticKey, capability);
    if ((inspected.status !== "provider_backed" && inspected.status !== "deterministic_empty") ||
        inspected.artifact === undefined) return false;
    try {
      assertSemanticArtifactCompatibility({ ...task, capability }, inspected.artifact, false);
      return true;
    } catch {
      return false;
    }
  });
  if (!capabilitiesAreCompatible(contract.requirements, available)) {
    return "capability requirements unavailable";
  }
  return undefined;
}
