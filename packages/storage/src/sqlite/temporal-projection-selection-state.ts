import { randomUUID } from "node:crypto";
import type { SqliteConnection } from "./db.js";
import { StorageError } from "../shared/errors.js";

type SelectionTransitionKind = "selected" | "rolled_back";

interface TemporalSelectionStateRow {
  readonly temporal_projection_selected: unknown;
  readonly temporal_projection_selection_required: unknown;
  readonly selection_id: unknown;
  readonly selected_at: unknown;
  readonly active_projection_generation: unknown;
}

interface TemporalSelectionAuditRow {
  readonly transition_id: unknown;
  readonly selection_id: unknown;
  readonly transition_kind: unknown;
  readonly previous_selected: unknown;
  readonly next_selected: unknown;
  readonly candidate_sha256: unknown;
  readonly source_file_set_digest: unknown;
  readonly projection_generation: unknown;
  readonly occurred_at: unknown;
  readonly reason: unknown;
}

export interface TemporalProjectionSelectionAuditEntry {
  readonly transitionId: string;
  readonly selectionId: string;
  readonly transitionKind: SelectionTransitionKind;
  readonly previousSelected: boolean;
  readonly nextSelected: boolean;
  readonly candidateSha256: string;
  readonly sourceFileSetDigest: string;
  readonly projectionGeneration: string;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface TemporalProjectionSelectionState {
  readonly schema: "legacy" | "temporal";
  readonly selectionRequired: boolean;
  readonly selected: boolean;
  readonly selectionId: string | null;
  readonly selectedAt: string | null;
  readonly activeProjectionGeneration: string | null;
  readonly audit: readonly TemporalProjectionSelectionAuditEntry[];
}

export function hasTemporalSelectionSchema(database: SqliteConnection): boolean {
  try {
    database.prepare("SELECT 1 FROM temporal_schema_state LIMIT 1").get();
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw new StorageError("QUERY_FAILED", "Failed to inspect temporal projection selection state.", error);
  }
  try {
    database.prepare(`
      SELECT temporal_projection_selected, temporal_projection_selection_required
      FROM temporal_schema_state
      WHERE state_id = 1
    `).get();
    return true;
  } catch (error) {
    throw new StorageError("CONFLICT", "Temporal projection selection schema is incomplete.", error);
  }
}

export function readTemporalSelectionState(database: SqliteConnection): TemporalProjectionSelectionState {
  let row: TemporalSelectionStateRow | undefined;
  try {
    row = database.prepare(`
      SELECT temporal_projection_selected, temporal_projection_selection_required,
             selection_id, selected_at, active_projection_generation
      FROM temporal_schema_state
      WHERE state_id = 1
    `).get() as TemporalSelectionStateRow | undefined;
  } catch (error) {
    throw new StorageError("QUERY_FAILED", "Failed to read temporal projection selection state.", error);
  }
  if (row === undefined) {
    throw new StorageError("CONFLICT", "Temporal projection state is missing its canonical row.");
  }
  const selected = parseSelectedFlag(row.temporal_projection_selected);
  const selectionRequired = parseSelectedFlag(row.temporal_projection_selection_required);
  const selectionId = parseNullableText(row.selection_id, "selection id");
  const selectedAt = parseNullableText(row.selected_at, "selected at");
  const activeProjectionGeneration = parseNullableText(
    row.active_projection_generation,
    "active projection generation"
  );
  if (selected && (selectionId === null || selectedAt === null || activeProjectionGeneration === null)) {
    throw new StorageError("CONFLICT", "Selected temporal projection state is incomplete.");
  }
  if (!selected && (selectionId !== null || selectedAt !== null)) {
    throw new StorageError("CONFLICT", "Unselected temporal projection state contains stale selection metadata.");
  }
  return Object.freeze({
    schema: "temporal",
    selectionRequired,
    selected,
    selectionId,
    selectedAt,
    activeProjectionGeneration,
    audit: readSelectionAudit(database)
  });
}

export function emptyLegacySelectionState(): TemporalProjectionSelectionState {
  return Object.freeze({
    schema: "legacy",
    selectionRequired: false,
    selected: false,
    selectionId: null,
    selectedAt: null,
    activeProjectionGeneration: null,
    audit: Object.freeze([])
  });
}

export function appendSelectionAudit(
  database: SqliteConnection,
  input: Omit<TemporalProjectionSelectionAuditEntry, "transitionId">
): void {
  database.prepare(`
    INSERT INTO temporal_projection_selection_audit (
      transition_id, selection_id, transition_kind, previous_selected, next_selected,
      candidate_sha256, source_file_set_digest, projection_generation, occurred_at, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.selectionId,
    input.transitionKind,
    input.previousSelected ? 1 : 0,
    input.nextSelected ? 1 : 0,
    input.candidateSha256,
    input.sourceFileSetDigest,
    input.projectionGeneration,
    input.occurredAt,
    input.reason
  );
}

function readSelectionAudit(database: SqliteConnection): readonly TemporalProjectionSelectionAuditEntry[] {
  let rows: readonly TemporalSelectionAuditRow[];
  try {
    rows = database.prepare(`
      SELECT transition_id, selection_id, transition_kind, previous_selected, next_selected,
             candidate_sha256, source_file_set_digest, projection_generation, occurred_at, reason
      FROM temporal_projection_selection_audit
      ORDER BY rowid ASC
    `).all() as readonly TemporalSelectionAuditRow[];
  } catch (error) {
    throw new StorageError("QUERY_FAILED", "Failed to read temporal projection selection audit.", error);
  }
  return Object.freeze(rows.map(parseSelectionAuditRow));
}

function parseSelectionAuditRow(row: TemporalSelectionAuditRow): TemporalProjectionSelectionAuditEntry {
  const transitionKind = row.transition_kind;
  if (transitionKind !== "selected" && transitionKind !== "rolled_back") {
    throw new StorageError("CONFLICT", "Temporal projection selection audit has an invalid transition kind.");
  }
  return Object.freeze({
    transitionId: parseRequiredText(row.transition_id, "audit transition id"),
    selectionId: parseRequiredText(row.selection_id, "audit selection id"),
    transitionKind,
    previousSelected: parseSelectedFlag(row.previous_selected),
    nextSelected: parseSelectedFlag(row.next_selected),
    candidateSha256: parseSha256(row.candidate_sha256, "audit candidate sha256"),
    sourceFileSetDigest: parseSha256(row.source_file_set_digest, "audit source file-set digest"),
    projectionGeneration: parseRequiredText(row.projection_generation, "audit projection generation"),
    occurredAt: parseIsoTimestamp(row.occurred_at, "audit occurred at"),
    reason: parseRequiredText(row.reason, "audit reason")
  });
}

function parseSelectedFlag(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new StorageError("CONFLICT", "Temporal projection selected flag is invalid.");
}

function parseNullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseRequiredText(value, label);
}

function parseRequiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 1_000) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return value.trim();
}

function parseIsoTimestamp(value: unknown, label: string): string {
  const parsed = parseRequiredText(value, label);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return parsed;
}

function parseSha256(value: unknown, label: string): string {
  const parsed = parseRequiredText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label}.`);
  }
  return parsed;
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/iu.test(error.message);
}
