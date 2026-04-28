import {
  assertIsoDatetime,
  assertObject,
  assertText
} from "../foundation/validation.js";
import { AlayaValidationError } from "../runtime/audit-types.js";
import { validatePortableBundleForImport } from "./portable.js";
import type {
  BackupResult,
  CreateBackupMetadataInput,
  PortableBackupMetadata
} from "./types.js";

export function createBackupMetadata(input: CreateBackupMetadataInput): PortableBackupMetadata {
  assertText(input.backup_id, "backup_id");
  assertIsoDatetime(input.created_at, "created_at");
  assertText(input.actor, "actor");
  assertText(input.reason, "reason");
  validateBackupResult(input.result);
  validateBackupStorage(input.storage);
  const sourceBundle = validatePortableBundleForImport(input.source_bundle);

  return {
    schema_version: 1,
    backup_id: input.backup_id,
    created_at: input.created_at,
    actor: input.actor,
    reason: input.reason,
    result: input.result,
    source_bundle_id: sourceBundle.metadata.bundle_id,
    profile_scope_id: sourceBundle.metadata.profile_scope_id,
    bundle_manifest: sourceBundle.manifest,
    integrity: sourceBundle.integrity,
    storage: input.storage,
    audit_event: {
      event_kind: `operations.backup.${input.result}`,
      actor: input.actor,
      source_bundle_id: sourceBundle.metadata.bundle_id,
      result: input.result,
      reason: input.reason,
      recorded_at: input.created_at,
      durable_truth_written: false
    }
  };
}

function validateBackupResult(result: BackupResult): void {
  if (result !== "created" && result !== "restored" && result !== "failed") {
    throw new AlayaValidationError("backup result is not supported.");
  }
}

function validateBackupStorage(storage: CreateBackupMetadataInput["storage"]): void {
  assertObject(storage, "storage");
  if (storage.driver !== "node:sqlite" && storage.driver !== "unknown") {
    throw new AlayaValidationError("storage.driver is not supported.");
  }
  assertText(storage.data_path_ref, "storage.data_path_ref");
  if (storage.database_state !== "initialized" && storage.database_state !== "unavailable") {
    throw new AlayaValidationError("storage.database_state is not supported.");
  }
}
