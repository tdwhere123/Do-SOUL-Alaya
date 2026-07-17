import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LongMemEvalMatrixPromotionAuthorizationSchema,
  hashPromotionMatrix,
  type LongMemEvalMatrixPromotionAuthorization
} from "../schema/authorization.js";
import {
  matrixCellForTreatment,
  parseLongMemEvalMatrixPromotionContract,
  type LongMemEvalMatrixPromotionContract
} from "../schema/contract.js";
import { authorizeLongMemEvalMatrixPromotion } from "../index.js";
import { immutableJsonClone } from "../schema/immutable-json.js";
import {
  resolveFrozenCodeIdentity,
  type FrozenCodeIdentity
} from "../../provenance/contract/frozen-code-contract.js";
import {
  computeExecutedDistIdentityFresh,
  isLongMemEvalRunProvenanceGateEligible
} from "../../provenance/run.js";
import { openContainedArtifact } from "../../../cli/merge/contained-artifact-path.js";
import { validateSnapshotManifest } from "../../snapshot/manifest-validation.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillSummary } from
  "../../extraction/fill/fill-authority.js";
import type { ExtractionRequestProfile } from "../../extraction/request-profile.js";
import {
  MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES,
  assertSnapshotExtractionAuthorityBinding,
  parseSnapshotExtractionAuthorityBytes
} from "../../snapshot/extraction-authority.js";
import { bindSnapshotRunProvenanceAuthority } from
  "../../snapshot/run-provenance.js";
import { MAX_SNAPSHOT_MANIFEST_BYTES } from
  "../../snapshot/artifact-limits.js";

declare const expansionCapabilityBrand: unique symbol;

export interface LongMemEvalExpansionCapability {
  readonly [expansionCapabilityBrand]: true;
}

export interface LongMemEvalSourceCacheAuthority {
  readonly manifestSha256: string;
  readonly extractionModel: string;
  readonly modelFamily: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly providerUrl: string;
  readonly systemPromptSha256: string;
  readonly cacheKeyAlgo: string;
  readonly dataset: string;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly expectedTurns: number;
  readonly expectedKeySetSha256: string;
  readonly contentClosureSha256: string;
}

export interface LongMemEvalSourceSnapshotAuthority {
  readonly dbPath: string;
  readonly manifestSha256: string;
  readonly dbSha256: string;
  readonly sidecarSha256: string;
  readonly extractionCache: LongMemEvalSourceCacheAuthority;
}

export interface LongMemEvalExpansionCapabilityData {
  readonly contractSha256: string;
  /** Live R2 authorization, not merely the enclosing promotion contract. */
  readonly matrixAuthorizationSha256: string;
  readonly policyVersion: LongMemEvalMatrixPromotionContract["policy_version"];
  readonly code: LongMemEvalMatrixPromotionContract["code"];
  readonly sourceSelection: LongMemEvalMatrixPromotionAuthorization["source_selection"];
  readonly nextSelection: LongMemEvalMatrixPromotionAuthorization["next_selection"];
  readonly matrix: LongMemEvalMatrixPromotionAuthorization["matrix"];
  readonly productDefault: LongMemEvalMatrixPromotionAuthorization["product_default"];
  readonly sourceSnapshot: LongMemEvalSourceSnapshotAuthority;
}

export interface LongMemEvalExpansionCapabilityInput {
  readonly checkoutRoot: string;
  readonly contractPath: string;
  readonly contractRoot: string;
  readonly contractContents: string | Uint8Array;
}

export interface LongMemEvalExpansionCapabilityDependencies {
  readonly authorize: typeof authorizeLongMemEvalMatrixPromotion;
  readonly readSourceSnapshotAuthority: typeof readLongMemEvalSourceSnapshotAuthority;
  readonly resolveFrozenCodeIdentity: typeof resolveFrozenCodeIdentity;
  readonly computeExecutedDistIdentity: () => Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: LongMemEvalExpansionCapabilityDependencies = {
  authorize: authorizeLongMemEvalMatrixPromotion,
  readSourceSnapshotAuthority: readLongMemEvalSourceSnapshotAuthority,
  resolveFrozenCodeIdentity,
  computeExecutedDistIdentity: computeExecutedDistIdentityFresh
};

const verifiedCapabilities = new WeakMap<object, LongMemEvalExpansionCapabilityData>();

export async function verifyLongMemEvalExpansionCapability(
  input: LongMemEvalExpansionCapabilityInput,
  dependencies: LongMemEvalExpansionCapabilityDependencies = DEFAULT_DEPENDENCIES
): Promise<LongMemEvalExpansionCapability> {
  assertContractLocation(input);
  const parsed = parseLongMemEvalMatrixPromotionContract(input.contractContents);
  const authorization = LongMemEvalMatrixPromotionAuthorizationSchema.parse(
    await dependencies.authorize({
      contractRoot: input.contractRoot,
      contractContents: input.contractContents
    })
  );
  assertAuthorizationBinding(parsed, authorization);
  const sourceSnapshot = await dependencies.readSourceSnapshotAuthority({
    contractRoot: input.contractRoot,
    contract: parsed.contract,
    sourceSelection: authorization.source_selection
  });
  await assertCurrentCodeIdentity(input, parsed, dependencies);
  return sealExpansionCapability({
    contractSha256: parsed.sha256,
    matrixAuthorizationSha256: authorization.authorization_sha256,
    policyVersion: parsed.contract.policy_version,
    code: parsed.contract.code,
    sourceSelection: authorization.source_selection,
    nextSelection: authorization.next_selection,
    matrix: authorization.matrix,
    productDefault: authorization.product_default,
    sourceSnapshot
  });
}

export function longMemEvalExpansionCapabilityData(
  capability: LongMemEvalExpansionCapability
): LongMemEvalExpansionCapabilityData {
  const data = verifiedCapabilities.get(capability);
  if (data === undefined) {
    throw new Error("LongMemEval expansion capability is not live-verified");
  }
  return data;
}

export async function readLongMemEvalSourceSnapshotAuthority(input: {
  readonly contractRoot: string;
  readonly contract: LongMemEvalMatrixPromotionContract;
  readonly sourceSelection: LongMemEvalMatrixPromotionAuthorization["source_selection"];
}): Promise<LongMemEvalSourceSnapshotAuthority> {
  const reference = `${input.contract.snapshot.db_path}.manifest.json`;
  const authorityReference = `${input.contract.snapshot.db_path}.extraction-authority.json`;
  const [file, authorityFile] = await Promise.all([
    openContainedArtifact(input.contractRoot, reference),
    openContainedArtifact(input.contractRoot, authorityReference)
  ]);
  if (file === null || authorityFile === null) {
    await Promise.all([file?.close(), authorityFile?.close()]);
    throw new Error("missing promotion source snapshot authority artifact");
  }
  try {
    const bytes = await file.readBytes(MAX_SNAPSHOT_MANIFEST_BYTES);
    if (sha256(bytes) !== input.contract.snapshot.manifest_sha256) {
      throw new Error("source snapshot manifest differs from promotion contract");
    }
    const manifest = validateSnapshotManifest(parseJson(bytes, reference), reference);
    const authorityBytes = await authorityFile.readBytes(
      MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
    );
    assertSourceExtractionAuthority(manifest, authorityReference, authorityBytes);
    assertSourceSnapshotManifest(manifest, input);
    return buildSourceSnapshotAuthority(input.contract, manifest);
  } finally {
    await Promise.all([file.close(), authorityFile.close()]);
  }
}

function assertSourceExtractionAuthority(
  manifest: ReturnType<typeof validateSnapshotManifest>,
  reference: string,
  bytes: Uint8Array
): void {
  const integrity = manifest.artifact_integrity;
  const extraction = manifest.extraction_provenance;
  if (integrity?.extraction_authority_filename !== path.basename(reference) ||
      integrity.extraction_authority_sha256 !== sha256(bytes) ||
      integrity.extraction_authority_bytes !== bytes.byteLength ||
      extraction?.schema_version !== 3) {
    throw new Error("source snapshot extraction authority differs from manifest");
  }
  const authority = parseSnapshotExtractionAuthorityBytes(bytes, reference);
  assertSnapshotExtractionAuthorityBinding(authority, extraction);
  if (manifest.run_provenance === undefined ||
      !isLongMemEvalRunProvenanceGateEligible(
        bindSnapshotRunProvenanceAuthority(manifest.run_provenance, authority)
      )) {
    throw new Error("source snapshot run authority is incomplete");
  }
}

async function assertCurrentCodeIdentity(
  input: LongMemEvalExpansionCapabilityInput,
  parsed: ReturnType<typeof parseLongMemEvalMatrixPromotionContract>,
  dependencies: LongMemEvalExpansionCapabilityDependencies
): Promise<void> {
  const frozen = await dependencies.resolveFrozenCodeIdentity({
    checkoutRoot: input.checkoutRoot,
    expectedCommitSha7: parsed.contract.code.commit_sha7,
    env: {
      ALAYA_BENCH_GATE_CONTRACT_PATH: input.contractPath,
      ALAYA_BENCH_GATE_SHA256: parsed.sha256,
      ALAYA_BENCH_WORKTREE_STATE_SHA256: parsed.contract.code.worktree_state_sha256
    }
  });
  assertFrozenCodeIdentity(frozen, parsed.contract.code, parsed.sha256);
  const executedDist = await dependencies.computeExecutedDistIdentity();
  if (!isDeepStrictEqual(executedDist, parsed.contract.code.executed_dist)) {
    throw new Error("current executed dist differs from promotion contract");
  }
}

function assertFrozenCodeIdentity(
  frozen: FrozenCodeIdentity | null,
  code: LongMemEvalMatrixPromotionContract["code"],
  contractSha256: string
): void {
  if (frozen === null) throw new Error("promotion contract did not verify current code");
  if (frozen.gateSha256 !== contractSha256) {
    throw new Error("live promotion contract digest differs from descriptor input");
  }
  if (frozen.commitSha !== code.commit_sha || frozen.commitSha7 !== code.commit_sha7 ||
      frozen.worktreeStateSha256 !== code.worktree_state_sha256) {
    throw new Error("current git identity differs from promotion contract");
  }
}

function assertAuthorizationBinding(
  parsed: ReturnType<typeof parseLongMemEvalMatrixPromotionContract>,
  authorization: LongMemEvalMatrixPromotionAuthorization
): void {
  if (authorization.contract_sha256 !== parsed.sha256 ||
      authorization.policy_version !== parsed.contract.policy_version ||
      authorization.source_selection.selected_count !== 100 ||
      authorization.next_selection.selected_count !== 500 ||
      authorization.source_selection.dataset_sha256 !==
        authorization.next_selection.dataset_sha256) {
    throw new Error("live matrix authorization differs from promotion progression");
  }
  if (authorization.matrix.sha256 !== hashPromotionMatrix(authorization.matrix.cells)) {
    throw new Error("live matrix authorization has an invalid matrix closure");
  }
  assertMatrixReceiptMatchesContract(parsed.contract, authorization);
}

function assertMatrixReceiptMatchesContract(
  contract: LongMemEvalMatrixPromotionContract,
  authorization: LongMemEvalMatrixPromotionAuthorization
): void {
  const expected = canonicalMatrixCells(contract.matrix.entries.map((entry) => ({
    cell: matrixCellForTreatment(entry.treatment),
    treatment: entry.treatment,
    evidence_root: entry.evidence_root
  })));
  const actual = canonicalMatrixCells(authorization.matrix.cells.map((cell) => ({
    cell: cell.cell,
    treatment: cell.treatment,
    evidence_root: cell.evidence_root
  })), true);
  const productCell = authorization.matrix.cells.find((cell) => cell.cell === "B");
  if (!isDeepStrictEqual(actual, expected) || productCell === undefined ||
      authorization.product_default.cell !== "B" ||
      !isDeepStrictEqual(authorization.product_default.treatment, productCell.treatment) ||
      authorization.product_default.bundle_sha256 !== productCell.bundle_sha256) {
    throw new Error("live matrix authorization differs from frozen matrix contract");
  }
}

function canonicalMatrixCells<T extends {
  readonly cell: "A" | "B" | "C" | "D";
  readonly treatment: LongMemEvalMatrixPromotionContract["matrix"]["entries"][number]["treatment"];
}>(cells: readonly T[], verifyLabels = false): readonly T[] {
  const byCell = new Map<T["cell"], T>();
  for (const cell of cells) {
    if ((verifyLabels && matrixCellForTreatment(cell.treatment) !== cell.cell) ||
        byCell.has(cell.cell)) {
      throw new Error("promotion matrix has duplicate or mislabeled treatment cells");
    }
    byCell.set(cell.cell, cell);
  }
  const canonical = (["A", "B", "C", "D"] as const).map((cell) => byCell.get(cell));
  if (canonical.some((cell) => cell === undefined)) {
    throw new Error("promotion matrix is missing a treatment cell");
  }
  return canonical as readonly T[];
}

function assertSourceSnapshotManifest(
  manifest: ReturnType<typeof validateSnapshotManifest>,
  input: Parameters<typeof readLongMemEvalSourceSnapshotAuthority>[0]
): void {
  const provenance = manifest.run_provenance;
  const extraction = manifest.extraction_provenance;
  if (manifest.variant !== input.contract.dataset.variant ||
      manifest.question_count !== 100 ||
      manifest.dataset_sha256 !== input.sourceSelection.dataset_sha256 ||
      manifest.attribution?.gate_eligible !== true ||
      manifest.artifact_integrity === undefined || provenance === undefined ||
      !isDeepStrictEqual(provenance.selection, input.sourceSelection) ||
      provenance.code.commit_sha !== input.contract.code.commit_sha ||
      provenance.code.worktree_state_sha256 !== input.contract.code.worktree_state_sha256 ||
      extraction === null || extraction.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      !hasCompleteExtractionFillSummary(extraction) ||
      extraction.window_offset !== 0 || extraction.window_limit !== 100 ||
      extraction.dataset_revision !== input.sourceSelection.dataset_sha256) {
    throw new Error("source snapshot cannot authorize canonical 100Q expansion");
  }
}

function buildSourceSnapshotAuthority(
  contract: LongMemEvalMatrixPromotionContract,
  manifest: ReturnType<typeof validateSnapshotManifest>
): LongMemEvalSourceSnapshotAuthority {
  const extraction = manifest.extraction_provenance!;
  const integrity = manifest.artifact_integrity!;
  if (extraction.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION ||
      !hasCompleteExtractionFillSummary(extraction)) {
    throw new Error("source snapshot extraction cache authority is incomplete");
  }
  return immutableJsonClone({
    dbPath: contract.snapshot.db_path,
    manifestSha256: contract.snapshot.manifest_sha256,
    dbSha256: integrity.db_sha256,
    sidecarSha256: integrity.sidecar_sha256,
    extractionCache: {
      manifestSha256: extraction.manifest_sha256,
      extractionModel: extraction.extraction_model,
      modelFamily: extraction.model_family,
      requestProfile: extraction.request_profile,
      providerUrl: extraction.provider_url,
      systemPromptSha256: extraction.system_prompt_sha256,
      cacheKeyAlgo: extraction.cache_key_algo,
      dataset: extraction.dataset,
      datasetRevision: extraction.dataset_revision,
      windowOffset: extraction.window_offset,
      windowLimit: extraction.window_limit,
      expectedTurns: extraction.expected_turns,
      expectedKeySetSha256: extraction.expected_key_set_sha256,
      contentClosureSha256: extraction.content_closure_sha256
    }
  });
}

function sealExpansionCapability(
  data: LongMemEvalExpansionCapabilityData
): LongMemEvalExpansionCapability {
  const capability = Object.freeze({}) as LongMemEvalExpansionCapability;
  verifiedCapabilities.set(capability, immutableJsonClone(data));
  return capability;
}

function assertContractLocation(input: LongMemEvalExpansionCapabilityInput): void {
  if (path.dirname(path.resolve(input.contractPath)) !== path.resolve(input.contractRoot)) {
    throw new Error("promotion contract path must be inside its descriptor-bound root");
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new Error(`invalid promotion source snapshot manifest: ${label}`, { cause });
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
