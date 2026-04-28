import { createHash } from "node:crypto";
import {
  assertIsoDatetime,
  assertNonNegativeInteger,
  assertObject,
  assertText,
  assertTextArray
} from "../foundation/validation.js";
import { ontologyObjectKinds } from "../foundation/types.js";
import { validateOntologyRecord } from "../ontology/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import type { AuditedMutationRecord } from "../runtime/audit-types.js";
import { isJsonObject } from "../runtime/json.js";
import { redactString } from "../runtime/redaction.js";
import type { OntologyRecord } from "../ontology/types.js";
import {
  portableBundleSchemaVersion,
  portableIntegrityAlgorithm,
  portableManifestVersion
} from "./types.js";
import type {
  CreatePortableBundleInput,
  PortableBundle,
  PortableBundleIntegrity,
  PortableBundleManifest,
  PortableBundleManifestCounts,
  PortableBundlePayload,
  PortableProfileScopeSnapshot,
  PortableSourceRef
} from "./types.js";

export function createPortableBundle(input: CreatePortableBundleInput): PortableBundle {
  assertText(input.bundle_id, "bundle_id");
  assertIsoDatetime(input.created_at, "created_at");
  assertText(input.created_by, "created_by");
  assertText(input.profile_scope_id, "profile_scope_id");

  const payload: PortableBundlePayload = {
    ontology_records: [...input.ontology_records],
    source_refs: [...input.source_refs],
    governance_audit: [...input.governance_audit],
    profile_scopes: [...input.profile_scopes]
  };
  const payloadSha256 = hashPortablePayload(payload);
  const integrity: PortableBundleIntegrity = {
    algorithm: portableIntegrityAlgorithm,
    payload_sha256: payloadSha256
  };
  const bundle: PortableBundle = {
    kind: "alaya.portable_bundle",
    schema_version: portableBundleSchemaVersion,
    metadata: {
      bundle_id: input.bundle_id,
      created_at: input.created_at,
      created_by: input.created_by,
      profile_scope_id: input.profile_scope_id,
      excluded_runtime_artifacts: [...(input.runtime_artifacts ?? [])]
    },
    payload,
    manifest: createManifest(input, payload, payloadSha256),
    integrity
  };

  return validatePortableBundleForImport(bundle);
}

export function validatePortableBundleForImport(bundle: PortableBundle): PortableBundle {
  assertObject(bundle, "PortableBundle");
  if (bundle.kind !== "alaya.portable_bundle") {
    throw new AlayaValidationError("Portable bundle kind is not supported.");
  }
  if (bundle.schema_version !== portableBundleSchemaVersion) {
    throw new AlayaValidationError(`Unsupported portable bundle schema version: ${String(bundle.schema_version)}.`);
  }
  assertObject(bundle.metadata, "metadata");
  assertText(bundle.metadata.bundle_id, "metadata.bundle_id");
  assertIsoDatetime(bundle.metadata.created_at, "metadata.created_at");
  assertText(bundle.metadata.created_by, "metadata.created_by");
  assertText(bundle.metadata.profile_scope_id, "metadata.profile_scope_id");
  validateManifest(bundle.manifest, bundle.metadata);
  validateIntegrity(bundle);
  validatePayloadShape(bundle.payload);
  validatePayloadReferences(bundle.payload);
  validateGovernanceAuditTargets(bundle.payload);
  validateManifestMatchesPayload(bundle.manifest, bundle.payload);
  return bundle;
}

export function hashPortablePayload(payload: PortableBundlePayload): string {
  return createHash(portableIntegrityAlgorithm).update(stableStringify(payload)).digest("hex");
}

function createManifest(
  input: CreatePortableBundleInput,
  payload: PortableBundlePayload,
  payloadSha256: string
): PortableBundleManifest {
  const counts = manifestCounts(payload);
  return {
    manifest_version: portableManifestVersion,
    schema_version: portableBundleSchemaVersion,
    bundle_id: input.bundle_id,
    created_at: input.created_at,
    created_by: input.created_by,
    profile_scope_id: input.profile_scope_id,
    counts,
    ontology_object_ids: sorted(payload.ontology_records.map((record) => record.object_id)),
    evidence_object_ids: sorted(payload.ontology_records
      .filter((record) => record.object_kind === "evidence_capsule")
      .map((record) => record.object_id)),
    governance_audit_event_ids: sorted(payload.governance_audit.map((record) => record.auditEventId)),
    source_refs: sorted(payload.source_refs.map((source) => source.source_ref)),
    profile_scope_ids: sorted(payload.profile_scopes.map((scope) => scope.scope_id)),
    excluded_runtime_artifact_count: input.runtime_artifacts?.length ?? 0,
    payload_sha256: payloadSha256
  };
}

function validateManifest(manifest: PortableBundleManifest, metadata: PortableBundle["metadata"]): void {
  assertObject(manifest, "manifest");
  if (manifest.manifest_version !== portableManifestVersion) {
    throw new AlayaValidationError("Portable bundle manifest version is not supported.");
  }
  if (manifest.schema_version !== portableBundleSchemaVersion) {
    throw new AlayaValidationError("Portable bundle manifest schema version is not supported.");
  }
  assertText(manifest.bundle_id, "manifest.bundle_id");
  assertIsoDatetime(manifest.created_at, "manifest.created_at");
  assertText(manifest.created_by, "manifest.created_by");
  assertText(manifest.profile_scope_id, "manifest.profile_scope_id");
  if (manifest.bundle_id !== metadata.bundle_id) {
    throw new AlayaValidationError("Portable bundle manifest bundle_id must match metadata.");
  }
  if (manifest.created_at !== metadata.created_at) {
    throw new AlayaValidationError("Portable bundle manifest created_at must match metadata.");
  }
  if (manifest.created_by !== metadata.created_by) {
    throw new AlayaValidationError("Portable bundle manifest created_by must match metadata.");
  }
  if (manifest.profile_scope_id !== metadata.profile_scope_id) {
    throw new AlayaValidationError("Portable bundle manifest profile_scope_id must match metadata.");
  }
  assertNonNegativeInteger(manifest.excluded_runtime_artifact_count, "manifest.excluded_runtime_artifact_count");
  assertText(manifest.payload_sha256, "manifest.payload_sha256");
  validateCounts(manifest.counts);
  assertTextArray(manifest.ontology_object_ids, "manifest.ontology_object_ids");
  assertTextArray(manifest.evidence_object_ids, "manifest.evidence_object_ids");
  assertTextArray(manifest.governance_audit_event_ids, "manifest.governance_audit_event_ids");
  assertTextArray(manifest.source_refs, "manifest.source_refs");
  assertTextArray(manifest.profile_scope_ids, "manifest.profile_scope_ids");
}

function validateIntegrity(bundle: PortableBundle): void {
  assertObject(bundle.integrity, "integrity");
  if (bundle.integrity.algorithm !== portableIntegrityAlgorithm) {
    throw new AlayaValidationError("Portable bundle integrity algorithm is not supported.");
  }
  const expectedPayloadHash = hashPortablePayload(bundle.payload);
  if (
    bundle.integrity.payload_sha256 !== expectedPayloadHash ||
    bundle.manifest.payload_sha256 !== expectedPayloadHash
  ) {
    throw new AlayaValidationError("Portable bundle integrity check failed.");
  }
}

function validatePayloadShape(payload: PortableBundlePayload): void {
  assertObject(payload, "payload");
  if ("runtime_artifacts" in payload) {
    throw new AlayaValidationError("Runtime artifacts cannot be imported as durable truth.");
  }
  if (!Array.isArray(payload.ontology_records)) {
    throw new AlayaValidationError("payload.ontology_records must be an array.");
  }
  if (!Array.isArray(payload.source_refs)) {
    throw new AlayaValidationError("payload.source_refs must be an array.");
  }
  if (!Array.isArray(payload.governance_audit)) {
    throw new AlayaValidationError("payload.governance_audit must be an array.");
  }
  if (!Array.isArray(payload.profile_scopes)) {
    throw new AlayaValidationError("payload.profile_scopes must be an array.");
  }
  for (const [index, record] of payload.ontology_records.entries()) {
    assertObject(record, `payload.ontology_records[${index}]`);
    if (!ontologyObjectKinds.includes(record.object_kind as (typeof ontologyObjectKinds)[number])) {
      throw new AlayaValidationError(`Runtime artifact ${String(record.object_kind)} cannot be imported as durable truth.`);
    }
    validateOntologyRecord(record as unknown as OntologyRecord);
  }
  payload.source_refs.forEach(validateSourceRef);
  payload.governance_audit.forEach(validateGovernanceAuditRecord);
  payload.profile_scopes.forEach(validateProfileScope);
}

function validatePayloadReferences(payload: PortableBundlePayload): void {
  const evidenceRecords = new Map(
    payload.ontology_records
      .filter((record) => record.object_kind === "evidence_capsule")
      .map((record) => [record.object_id, record])
  );
  const ontologyObjectIds = new Set(payload.ontology_records.map((record) => record.object_id));
  const sourceTargetIds = new Map<string, string[]>();
  const sourceRefs = new Set(payload.source_refs.map((source) => source.source_ref));
  for (const source of payload.source_refs) {
    for (const targetId of source.target_object_ids) {
      const refs = sourceTargetIds.get(targetId) ?? [];
      refs.push(source.source_ref);
      sourceTargetIds.set(targetId, refs);
    }
  }

  for (const record of payload.ontology_records) {
    if (!sourceTargetIds.has(record.object_id)) {
      throw new AlayaValidationError(`Source reference not found for ${record.object_id}.`);
    }
    for (const evidenceRef of evidenceRefsFor(record)) {
      const evidence = evidenceRecords.get(evidenceRef);
      if (evidence === undefined) {
        throw new AlayaValidationError(`Evidence reference ${evidenceRef} not found for ${record.object_id}.`);
      }
      if (evidence.evidence_health_state === "broken") {
        throw new AlayaValidationError(`Evidence reference ${evidenceRef} is broken and cannot support import.`);
      }
    }
  }

  for (const source of payload.source_refs) {
    for (const targetId of source.target_object_ids) {
      if (!ontologyObjectIds.has(targetId)) {
        throw new AlayaValidationError(`Source reference ${source.source_ref} targets missing object ${targetId}.`);
      }
    }
  }

  const governanceAuditIds = new Set(payload.governance_audit.map((record) => record.auditEventId));
  for (const audit of payload.governance_audit) {
    if (!sourceRefs.has(audit.source.ref)) {
      throw new AlayaValidationError(`Governance audit ${audit.auditEventId} source ref is missing from bundle sources.`);
    }
    for (const evidence of audit.evidence) {
      if (!evidenceRecords.has(evidence.ref)) {
        throw new AlayaValidationError(`Governance audit ${audit.auditEventId} evidence ref ${evidence.ref} is missing.`);
      }
    }
  }

  for (const profileScope of payload.profile_scopes) {
    if (!sourceRefs.has(profileScope.source_ref)) {
      throw new AlayaValidationError(`Profile scope ${profileScope.scope_id} source ref is missing from bundle sources.`);
    }
    for (const evidenceRef of profileScope.evidence_refs) {
      if (!evidenceRecords.has(evidenceRef)) {
        throw new AlayaValidationError(`Profile scope ${profileScope.scope_id} evidence ref ${evidenceRef} is missing.`);
      }
    }
    for (const auditRef of profileScope.governance_audit_refs) {
      if (!governanceAuditIds.has(auditRef)) {
        throw new AlayaValidationError(`Profile scope ${profileScope.scope_id} audit ref ${auditRef} is missing.`);
      }
    }
  }
}

function validateManifestMatchesPayload(manifest: PortableBundleManifest, payload: PortableBundlePayload): void {
  const expectedCounts = manifestCounts(payload);
  if (stableStringify(manifest.counts) !== stableStringify(expectedCounts)) {
    throw new AlayaValidationError("Portable bundle manifest counts do not match payload.");
  }
  expectSameSorted(manifest.ontology_object_ids, payload.ontology_records.map((record) => record.object_id), "ontology_object_ids");
  expectSameSorted(
    manifest.evidence_object_ids,
    payload.ontology_records.filter((record) => record.object_kind === "evidence_capsule").map((record) => record.object_id),
    "evidence_object_ids"
  );
  expectSameSorted(
    manifest.governance_audit_event_ids,
    payload.governance_audit.map((record) => record.auditEventId),
    "governance_audit_event_ids"
  );
  expectSameSorted(manifest.source_refs, payload.source_refs.map((source) => source.source_ref), "source_refs");
  expectSameSorted(manifest.profile_scope_ids, payload.profile_scopes.map((scope) => scope.scope_id), "profile_scope_ids");
}

function manifestCounts(payload: PortableBundlePayload): PortableBundleManifestCounts {
  return {
    ontology_records: payload.ontology_records.length,
    evidence_capsules: payload.ontology_records.filter((record) => record.object_kind === "evidence_capsule").length,
    memory_entries: payload.ontology_records.filter((record) => record.object_kind === "memory_entry").length,
    synthesis_capsules: payload.ontology_records.filter((record) => record.object_kind === "synthesis_capsule").length,
    claim_forms: payload.ontology_records.filter((record) => record.object_kind === "claim_form").length,
    governance_audit_records: payload.governance_audit.length,
    profile_scopes: payload.profile_scopes.length
  };
}

function validateCounts(counts: PortableBundleManifestCounts): void {
  assertObject(counts, "manifest.counts");
  assertNonNegativeInteger(counts.ontology_records, "manifest.counts.ontology_records");
  assertNonNegativeInteger(counts.evidence_capsules, "manifest.counts.evidence_capsules");
  assertNonNegativeInteger(counts.memory_entries, "manifest.counts.memory_entries");
  assertNonNegativeInteger(counts.synthesis_capsules, "manifest.counts.synthesis_capsules");
  assertNonNegativeInteger(counts.claim_forms, "manifest.counts.claim_forms");
  assertNonNegativeInteger(counts.governance_audit_records, "manifest.counts.governance_audit_records");
  assertNonNegativeInteger(counts.profile_scopes, "manifest.counts.profile_scopes");
}

function validateSourceRef(source: PortableSourceRef): void {
  assertObject(source, "PortableSourceRef");
  assertText(source.source_ref, "source_ref");
  assertText(source.source_kind, "source_kind");
  assertTextArray(source.target_object_ids, "target_object_ids", { nonEmpty: true });
  assertIsoDatetime(source.captured_at, "captured_at");
  if (source.summary !== null) {
    assertText(source.summary, "summary");
  }
}

function validateGovernanceAuditRecord(record: AuditedMutationRecord): void {
  assertObject(record, "AuditedMutationRecord");
  assertText(record.auditEventId, "auditEventId");
  assertText(record.mutationId, "mutationId");
  assertText(record.phase, "phase");
  assertText(record.status, "status");
  assertText(record.mutationKind, "mutationKind");
  assertObject(record.source, "source");
  assertText(record.source.kind, "source.kind");
  assertText(record.source.ref, "source.ref");
  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    throw new AlayaValidationError("Governance audit evidence must not be empty.");
  }
  for (const [index, evidence] of record.evidence.entries()) {
    assertObject(evidence, `evidence[${index}]`);
    assertText(evidence.kind, `evidence[${index}].kind`);
    assertText(evidence.ref, `evidence[${index}].ref`);
  }
  assertIsoDatetime(record.createdAt, "createdAt");
}

function validateProfileScope(scope: PortableProfileScopeSnapshot): void {
  assertObject(scope, "PortableProfileScopeSnapshot");
  assertText(scope.scope_id, "scope_id");
  if (scope.scope_kind !== "user" && scope.scope_kind !== "project") {
    throw new AlayaValidationError("scope_kind is not supported.");
  }
  assertText(scope.source_ref, "source_ref");
  assertTextArray(scope.evidence_refs, "evidence_refs", { nonEmpty: true });
  assertTextArray(scope.governance_audit_refs, "governance_audit_refs");
  if (!isJsonObject(scope.settings)) {
    throw new AlayaValidationError("settings must be a JSON object.");
  }
  validateSecretFreeProfileSettings(scope.settings, `profile_scopes.${scope.scope_id}.settings`);
}

function validateSecretFreeProfileSettings(value: unknown, path: string): void {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    if (redactString(value) !== value) {
      throw new AlayaValidationError(`Profile scope settings must not contain secret values at ${path}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateSecretFreeProfileSettings(entry, `${path}[${index}]`));
    return;
  }
  if (!isJsonObject(value)) {
    throw new AlayaValidationError(`Profile scope settings must be JSON at ${path}.`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (isSecretValueKey(key)) {
      throw new AlayaValidationError(`Profile scope settings must not contain secret-bearing key ${childPath}.`);
    }
    validateSecretFreeProfileSettings(child, childPath);
  }
}

function isSecretValueKey(key: string): boolean {
  if (/(^|[_-])secret[_-]?ref($|[_-])/i.test(key)) {
    return false;
  }
  return /(^|[_-])(api[_-]?key|authorization|credential|password|raw[_-]?secret|secret[_-]?value|token)($|[_-])/i.test(key);
}

function validateGovernanceAuditTargets(payload: PortableBundlePayload): void {
  const ontologyObjectIds = new Set(payload.ontology_records.map((record) => record.object_id));
  const profileScopeIds = new Set(payload.profile_scopes.map((scope) => scope.scope_id));
  const ontologyBackedTargetTypes = new Set<string>([
    ...ontologyObjectKinds,
    "memory_visibility",
    "promotion_candidate"
  ]);
  const externalGovernanceTargetTypes = new Set(["governance_action", "governance_bypass"]);

  for (const record of payload.governance_audit) {
    if (record.target?.id === undefined) {
      continue;
    }
    if (ontologyBackedTargetTypes.has(record.target.type)) {
      if (!ontologyObjectIds.has(record.target.id)) {
        throw new AlayaValidationError(`Governance audit target ${record.target.id} not found in portable ontology payload.`);
      }
      continue;
    }
    if (record.target.type === "profile_scope") {
      if (!profileScopeIds.has(record.target.id)) {
        throw new AlayaValidationError(`Governance audit target ${record.target.id} not found in portable profile scopes.`);
      }
      continue;
    }
    if (externalGovernanceTargetTypes.has(record.target.type)) {
      continue;
    }
    throw new AlayaValidationError(`Governance audit target type ${record.target.type} is not portable.`);
  }
}

function evidenceRefsFor(record: OntologyRecord): readonly string[] {
  switch (record.object_kind) {
    case "evidence_capsule":
      return [];
    case "memory_entry":
    case "synthesis_capsule":
    case "claim_form":
      return record.evidence_refs;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function expectSameSorted(left: readonly string[], right: readonly string[], label: string): void {
  if (stableStringify(sorted(left)) !== stableStringify(sorted(right))) {
    throw new AlayaValidationError(`Portable bundle manifest ${label} do not match payload.`);
  }
}
