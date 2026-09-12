import { join } from "node:path";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable, replaceBytesDurable } from
  "../manifest/durable-exclusive-publication.js";
import type { ExtractionCacheWriteLease } from "../manifest/fill-root-guard.js";
import type { GeminiBatchJob, GeminiBatchPlan, GeminiBatchState } from "./contract.js";
import { batchDigest, canonicalBatchPlan, MAX_BATCH_ARTIFACT_BYTES, prepareBatchJobs } from "./plan.js";
import { applyRemoteOperation, readBatchRemoteWitness, terminalBatchStates } from "./remote-operation.js";
import { record, resourceName } from "./native-codec.js";
import { deriveBatchUsage } from "./output-inventory.js";

const Nonnegative = z.number().int().nonnegative().safe();
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Usage = z.object({ inputTokens: Nonnegative, outputTokens: Nonnegative, totalTokens: Nonnegative }).strict();
const StateSchema = z.object({
  version: z.literal(1), transport: z.literal("gemini-batch"), planDigest: Digest,
  endpoint: z.string().url(), jobs: z.array(z.object({
    id: Digest, displayName: z.string(), lineKeys: z.array(z.string()), inputSha256: Digest,
    inputBytes: Nonnegative, inputTokenBound: Nonnegative, costBoundUsd: z.number().nonnegative().finite(),
    status: z.enum(["prepared", "uploading", "uploaded", "submission_unknown", "submitted", "running",
      "succeeded", "failed", "cancel_requested", "cancelled", "expired"]),
    inputFile: z.string().regex(/^files\/[a-zA-Z0-9_-]+$/u).optional(),
    remoteJob: z.string().regex(/^batches\/[a-zA-Z0-9_-]+$/u).optional(),
    outputFile: z.string().regex(/^files\/[a-zA-Z0-9_-]+$/u).optional(),
    submittedAt: Nonnegative.optional(), polls: Nonnegative, cancelRequested: z.boolean().optional(),
    attemptOrdinals: z.record(z.string(), z.number().int().positive().safe()).optional(),
    rawOutputSha256: Digest.optional(),
    outcomes: z.record(z.string(), z.object({
      status: z.enum(["admitted", "failed", "quarantined"]), reason: z.string().optional()
    }).strict()), usage: Usage.optional(), usageUnknown: z.boolean(), diagnostic: z.string().optional()
  }).strict())
}).strict();

export function openBatchState(input: {
  readonly plan: GeminiBatchPlan;
  readonly endpoint: string;
  readonly lease: ExtractionCacheWriteLease;
  readonly prepare: boolean;
}): GeminiBatchState {
  const { plan, lease } = input;
  lease.assertOwned();
  const path = statePath(lease, plan);
  const planDigest = batchDigest(JSON.stringify(plan));
  const jobs = prepareBatchJobs(plan);
  if (!boundedArtifactEntryExists(path)) {
    if (!input.prepare) throw new Error("Batch plan is not prepared");
    assertNewWindow(input);
    publishArtifact(lease, `batch-plan-${plan.identity}.json`, JSON.stringify(plan));
    for (const job of jobs) {
      // Exact input is published by the executor before any network operation.
      if (job.lineKeys.length === 0) throw new Error("empty Batch job");
    }
    const state: GeminiBatchState = {
      version: 1, transport: "gemini-batch", planDigest, endpoint: input.endpoint, jobs
    };
    saveBatchState(lease, plan, state);
    return state;
  }
  const state = StateSchema.parse(JSON.parse(readArtifact(lease, `batch-state-${plan.identity}.json`)));
  if (state.planDigest !== planDigest || state.endpoint !== input.endpoint || state.jobs.length !== jobs.length) {
    throw new Error("Batch plan/endpoint drift on resume");
  }
  for (let index = 0; index < jobs.length; index += 1) {
    const expected = jobs[index]!;
    const actual = state.jobs[index]!;
    for (const field of ["id", "displayName", "lineKeys", "inputSha256", "inputBytes",
      "inputTokenBound", "costBoundUsd"] as const) {
      if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) {
        throw new Error("Batch durable job binding mismatch");
      }
    }
    if (Object.keys(actual.outcomes).some((key) => !actual.lineKeys.includes(key))) {
      throw new Error("Batch durable outcome contains a foreign line");
    }
    assertBatchJobState(actual);
    recoverRemoteEvidence(lease, plan, actual);
    const retainedOutput = readRetainedBatchOutput(lease, actual);
    if (retainedOutput !== undefined) {
      actual.rawOutputSha256 = batchDigest(retainedOutput);
      const derived = deriveBatchUsage(retainedOutput, actual);
      if (derived.usage === undefined) delete actual.usage;
      else actual.usage = derived.usage;
      actual.usageUnknown = derived.usageUnknown;
    }
    assertBatchJobState(actual);
  }
  return state;
}

function recoverRemoteEvidence(lease: ExtractionCacheWriteLease, plan: GeminiBatchPlan, job: GeminiBatchJob): void {
  const attemptsName = `batch-attempts-${job.id}.json`;
  if (artifactExists(lease, attemptsName)) {
    const witness = record(JSON.parse(readArtifact(lease, attemptsName)));
    const ordinals = z.record(z.string(), z.number().int().positive().safe()).parse(witness.attemptOrdinals);
    if (job.submittedAt === undefined || witness.jobId !== job.id || witness.planIdentity !== plan.identity ||
        witness.inputSha256 !== job.inputSha256 ||
        (job.attemptOrdinals !== undefined && JSON.stringify(job.attemptOrdinals) !== JSON.stringify(ordinals))) {
      throw new Error("Batch durable attempt receipt binding mismatch");
    }
    job.attemptOrdinals ??= ordinals;
  } else if (job.attemptOrdinals !== undefined) throw new Error("Batch attempt ordinals lack durable receipt");
  let acknowledged = false;
  for (const kind of ["created", "reconciled"] as const) {
    const name = `batch-${kind}-${job.id}.json`;
    if (!artifactExists(lease, name)) continue;
    if (job.submittedAt === undefined) throw new Error("Batch remote receipt contradicts unsubmitted state");
    const operation = record(readBatchRemoteWitness(job, plan, JSON.parse(readArtifact(lease, name))));
    acknowledged = true;
    job.remoteJob ??= resourceName(operation.name, "batches");
    if (job.status === "submission_unknown") job.status = "submitted";
    if (kind === "reconciled") applyRemoteOperation(job, plan, operation);
  }
  if (job.remoteJob !== undefined && !acknowledged) throw new Error("Batch remote job lacks durable creation/reconciliation receipt");
  let observed = false;
  for (let ordinal = job.polls; ordinal > 0; ordinal -= 1) {
    const name = `batch-poll-${batchDigest(`${job.id}:${ordinal}`)}.json`;
    if (!artifactExists(lease, name)) continue;
    const operation = readBatchRemoteWitness(job, plan, JSON.parse(readArtifact(lease, name)));
    applyRemoteOperation(job, plan, operation);
    observed = true;
    break;
  }
  if (job.submittedAt !== undefined && terminalBatchStates.has(job.status) && !observed &&
      !artifactExists(lease, `batch-reconciled-${job.id}.json`)) {
    throw new Error("Batch terminal state lacks a durable remote observation");
  }
}

function assertBatchJobState(job: GeminiBatchJob): void {
  const unsubmitted = ["prepared", "uploading", "uploaded"].includes(job.status);
  if (unsubmitted && (job.submittedAt !== undefined || job.remoteJob !== undefined ||
      job.outputFile !== undefined || job.attemptOrdinals !== undefined || job.polls !== 0 || job.cancelRequested)) {
    throw new Error("Batch unsubmitted state contradicts submission evidence");
  }
  if (job.status === "uploaded" && job.inputFile === undefined || job.status === "prepared" && job.inputFile !== undefined) {
    throw new Error("Batch upload state contradicts input file identity");
  }
  if (job.submittedAt === undefined) {
    if (!unsubmitted && !(job.status === "cancelled" && job.cancelRequested)) throw new Error("Batch submission intent missing");
    if (job.remoteJob !== undefined || job.outputFile !== undefined || job.usage !== undefined ||
        job.rawOutputSha256 !== undefined || Object.keys(job.outcomes).length > 0 ||
        (!job.usageUnknown && job.status !== "cancelled")) throw new Error("Batch unsubmitted state contains remote results");
  } else if (job.inputFile === undefined || (job.status !== "submission_unknown" && job.remoteJob === undefined)) {
    throw new Error("Batch submitted state lacks its input or remote identity");
  }
  if (!job.usageUnknown && job.submittedAt !== undefined &&
      (job.usage === undefined || job.rawOutputSha256 === undefined)) throw new Error("Batch known usage lacks retained evidence");
  if ((job.rawOutputSha256 !== undefined || job.usage !== undefined || Object.keys(job.outcomes).length > 0) &&
      !terminalBatchStates.has(job.status)) throw new Error("Batch pending state contains terminal results");
  if (job.rawOutputSha256 !== undefined && (job.outputFile === undefined || job.remoteJob === undefined)) {
    throw new Error("Batch retained output lacks remote binding");
  }
  if (Object.values(job.outcomes).some((outcome) => outcome.status === "admitted") && job.rawOutputSha256 === undefined) {
    throw new Error("Batch admission lacks retained output");
  }
  if (job.attemptOrdinals !== undefined &&
      (JSON.stringify(Object.keys(job.attemptOrdinals).sort()) !== JSON.stringify([...job.lineKeys].sort()) ||
       new Set(Object.values(job.attemptOrdinals)).size !== job.lineKeys.length)) {
    throw new Error("Batch durable attempt bindings do not conserve selected lines");
  }
}

export function readRootBatchRuns(lease: ExtractionCacheWriteLease): readonly {
  readonly plan: GeminiBatchPlan; readonly state: GeminiBatchState;
}[] {
  lease.assertOwned();
  return readdirSync(lease.stableRootPath).filter((name) => /^batch-state-[a-f0-9]{64}\.json$/u.test(name))
    .sort().map((name) => {
      const identity = name.slice("batch-state-".length, -".json".length);
      const plan = canonicalBatchPlan(JSON.parse(readArtifact(lease, `batch-plan-${identity}.json`)) as GeminiBatchPlan);
      const state = StateSchema.parse(JSON.parse(readArtifact(lease, name)));
      if (plan.identity !== identity || state.planDigest !== batchDigest(JSON.stringify(plan))) {
        throw new Error("Batch root accounting plan/state binding mismatch");
      }
      // Validate immutable job structure with the same authority as ordinary resume.
      const verified = openBatchState({ plan, endpoint: state.endpoint, lease, prepare: false });
      return { plan, state: verified };
    });
}

function assertNewWindow(input: {
  readonly plan: GeminiBatchPlan; readonly endpoint: string; readonly lease: ExtractionCacheWriteLease;
}): void {
  const selectedKeys = new Set(input.plan.lines.map((line) => line.key));
  const selectedUnits = new Set(input.plan.lines.flatMap((line) => line.unitKeys));
  for (const prior of readRootBatchRuns(input.lease)) {
    if (prior.plan.model !== input.plan.model || prior.plan.requestProfile !== input.plan.requestProfile ||
        prior.state.endpoint !== input.endpoint ||
        prior.plan.limits.inputUsdPerMillion !== input.plan.limits.inputUsdPerMillion ||
        prior.plan.limits.outputUsdPerMillion !== input.plan.limits.outputUsdPerMillion ||
        prior.plan.limits.maxOutputTokens !== input.plan.limits.maxOutputTokens) {
      throw new Error("Batch root model/profile/endpoint/price contract cannot change between windows");
    }
    const activeKeys = new Set(prior.state.jobs.flatMap((job) => {
      if (!["succeeded", "failed", "cancelled", "expired"].includes(job.status)) return job.lineKeys;
      if (job.outputFile !== undefined || job.status === "succeeded") {
        return job.lineKeys.filter((key) => job.outcomes[key] === undefined);
      }
      return [];
    }));
    for (const line of prior.plan.lines) {
      if (activeKeys.has(line.key) && (selectedKeys.has(line.key) ||
          line.unitKeys.some((unit) => selectedUnits.has(unit)))) {
        throw new Error("Batch window overlaps pending or unknown work; resume it first");
      }
    }
  }
}

export function saveBatchState(lease: ExtractionCacheWriteLease, plan: GeminiBatchPlan, state: GeminiBatchState): void {
  lease.assertOwned();
  for (const job of state.jobs) assertBatchJobState(job);
  const bytes = Buffer.from(JSON.stringify(StateSchema.parse(state)), "utf8");
  if (bytes.length > MAX_BATCH_ARTIFACT_BYTES) throw new Error("Batch state exceeds byte cap");
  replaceBytesDurable({
    destination: statePath(lease, plan), bytes, ownerIdentity: lease.generation,
    temporaryDirectory: lease.stableRootPath
  });
  lease.assertOwned();
}

export function artifactExists(lease: ExtractionCacheWriteLease, name: string): boolean {
  lease.assertOwned();
  assertName(name);
  return boundedArtifactEntryExists(join(lease.stableRootPath, name));
}

export function readRetainedBatchOutput(lease: ExtractionCacheWriteLease, job: GeminiBatchJob): string | undefined {
  const name = `batch-output-${job.id}.jsonl`;
  const expected = retainedOutputDigest(lease, job);
  if (!artifactExists(lease, name)) {
    if (job.rawOutputSha256 !== undefined) throw new Error("Batch retained output artifact is missing");
    return undefined;
  }
  if (expected === undefined) throw new Error("Batch retained output has no durable download binding");
  const raw = readArtifact(lease, name);
  if (batchDigest(raw) !== expected || job.rawOutputSha256 !== undefined && job.rawOutputSha256 !== expected) {
    throw new Error("Batch output artifact digest mismatch");
  }
  return raw;
}

export function publishRetainedBatchOutput(lease: ExtractionCacheWriteLease, job: GeminiBatchJob, raw: string): string {
  const digest = batchDigest(raw);
  const previous = retainedOutputDigest(lease, job);
  if (previous !== undefined && previous !== digest || job.rawOutputSha256 !== undefined && job.rawOutputSha256 !== digest) {
    throw new Error("Batch output artifact digest mismatch");
  }
  // Bind exact raw bytes before publishing their file; a state-write crash can
  // subsequently recover from these two immutable artifacts without the network.
  publishArtifact(lease, `batch-download-${job.id}.json`, JSON.stringify({ binding: outputBinding(job), rawSha256: digest }));
  publishArtifact(lease, `batch-output-${job.id}.jsonl`, raw);
  return digest;
}

function retainedOutputDigest(lease: ExtractionCacheWriteLease, job: GeminiBatchJob): string | undefined {
  const name = `batch-download-${job.id}.json`;
  if (!artifactExists(lease, name)) return undefined;
  const retained = record(JSON.parse(readArtifact(lease, name)));
  if (JSON.stringify(retained.binding) !== JSON.stringify(outputBinding(job)) ||
      typeof retained.rawSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(retained.rawSha256)) {
    throw new Error("Batch retained download binding mismatch");
  }
  return retained.rawSha256;
}

function outputBinding(job: GeminiBatchJob): object {
  return { jobId: job.id, remoteJob: job.remoteJob, inputFile: job.inputFile,
    inputSha256: job.inputSha256, outputFile: job.outputFile };
}

export function publishArtifact(lease: ExtractionCacheWriteLease, name: string, text: string): string {
  lease.assertOwned();
  assertName(name);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_BATCH_ARTIFACT_BYTES) throw new Error("Batch artifact exceeds byte cap");
  publishBytesExclusiveDurable({
    destination: join(lease.stableRootPath, name), bytes, ownerIdentity: lease.generation,
    temporaryDirectory: lease.stableRootPath, allowExistingExact: true
  });
  lease.assertOwned();
  return batchDigest(text);
}

export function readArtifact(lease: ExtractionCacheWriteLease, name: string): string {
  lease.assertOwned();
  assertName(name);
  return readBoundedCanonicalUtf8Artifact({
    path: join(lease.stableRootPath, name), maxBytes: MAX_BATCH_ARTIFACT_BYTES, label: "Batch artifact"
  });
}

function statePath(lease: ExtractionCacheWriteLease, plan: GeminiBatchPlan): string {
  if (!/^[a-f0-9]{64}$/u.test(plan.identity)) throw new Error("invalid Batch plan identity");
  return join(lease.stableRootPath, `batch-state-${plan.identity}.json`);
}

function assertName(name: string): void {
  if (!/^batch-[a-z]+-[a-f0-9]{64}\.(json|jsonl)$/u.test(name)) throw new Error("invalid Batch artifact name");
}
