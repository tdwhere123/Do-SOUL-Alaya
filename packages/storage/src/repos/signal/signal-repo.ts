import {
  CandidateMemorySignalSchema,
  SignalState,
  SignalStateSchema,
  type CandidateMemorySignal,
  type SignalState as SignalStateType
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export interface SignalRepo {
  create(signal: CandidateMemorySignal): Promise<CandidateMemorySignal>;
  getById(signalId: string): Promise<CandidateMemorySignal | null>;
  listByRun(runId: string): Promise<readonly CandidateMemorySignal[]>;
  updateState(signalId: string, state: SignalStateType): Promise<CandidateMemorySignal>;
}

interface SignalRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly surface_id: string | null;
  readonly source: string;
  readonly signal_kind: string;
  readonly object_kind: string;
  readonly scope_hint: string | null;
  readonly domain_tags_json: string;
  readonly confidence: number;
  readonly evidence_refs_json: string;
  readonly source_memory_refs_json: string;
  readonly supersedes_refs_json: string;
  readonly exception_to_refs_json: string;
  readonly contradicts_refs_json: string;
  readonly incompatible_with_refs_json: string;
  readonly raw_payload_json: string;
  readonly signal_state: string;
  readonly created_at: string;
}

export class SqliteSignalRepo implements SignalRepo {
  private readonly createStatement;
  private readonly getByIdStatement;
  private readonly listByRunStatement;
  private readonly updateStateStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO signals (
        signal_id,
        workspace_id,
        run_id,
        surface_id,
        source,
        signal_kind,
        object_kind,
        scope_hint,
        domain_tags_json,
        confidence,
        evidence_refs_json,
        source_memory_refs_json,
        supersedes_refs_json,
        exception_to_refs_json,
        contradicts_refs_json,
        incompatible_with_refs_json,
        raw_payload_json,
        signal_state,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getByIdStatement = db.connection.prepare(`
      SELECT
        signal_id,
        workspace_id,
        run_id,
        surface_id,
        source,
        signal_kind,
        object_kind,
        scope_hint,
        domain_tags_json,
        confidence,
        evidence_refs_json,
        source_memory_refs_json,
        supersedes_refs_json,
        exception_to_refs_json,
        contradicts_refs_json,
        incompatible_with_refs_json,
        raw_payload_json,
        signal_state,
        created_at
      FROM signals
      WHERE signal_id = ?
      LIMIT 1
    `);
    this.listByRunStatement = db.connection.prepare(`
      SELECT
        signal_id,
        workspace_id,
        run_id,
        surface_id,
        source,
        signal_kind,
        object_kind,
        scope_hint,
        domain_tags_json,
        confidence,
        evidence_refs_json,
        source_memory_refs_json,
        supersedes_refs_json,
        exception_to_refs_json,
        contradicts_refs_json,
        incompatible_with_refs_json,
        raw_payload_json,
        signal_state,
        created_at
      FROM signals
      WHERE run_id = ?
      ORDER BY created_at ASC, signal_id ASC
    `);
    this.updateStateStatement = db.connection.prepare(`
      UPDATE signals
      SET signal_state = ?
      WHERE signal_id = ?
    `);
  }

  public async create(signal: CandidateMemorySignal): Promise<CandidateMemorySignal> {
    const parsedSignal = parseSignal(signal);

    try {
      this.createStatement.run(
        parsedSignal.signal_id,
        parsedSignal.workspace_id,
        parsedSignal.run_id,
        parsedSignal.surface_id,
        parsedSignal.source,
        parsedSignal.signal_kind,
        parsedSignal.object_kind,
        parsedSignal.scope_hint,
        JSON.stringify(parsedSignal.domain_tags),
        parsedSignal.confidence,
        JSON.stringify(parsedSignal.evidence_refs),
        JSON.stringify(parsedSignal.source_memory_refs),
        JSON.stringify(parsedSignal.supersedes_refs),
        JSON.stringify(parsedSignal.exception_to_refs),
        JSON.stringify(parsedSignal.contradicts_refs),
        JSON.stringify(parsedSignal.incompatible_with_refs),
        JSON.stringify(parsedSignal.raw_payload),
        SignalState.EMITTED,
        parsedSignal.created_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create signal ${parsedSignal.signal_id}.`, error);
    }

    return {
      ...parsedSignal,
      signal_state: SignalState.EMITTED
    };
  }

  public async getById(signalId: string): Promise<CandidateMemorySignal | null> {
    try {
      const row = this.getByIdStatement.get(signalId) as SignalRow | undefined;
      return row === undefined ? null : parseSignalRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load signal ${signalId}.`, error);
    }
  }

  public async listByRun(runId: string): Promise<readonly CandidateMemorySignal[]> {
    try {
      const rows = this.listByRunStatement.all(runId) as SignalRow[];
      return rows.map((row) => parseSignalRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list signals for run ${runId}.`, error);
    }
  }

  public async updateState(signalId: string, state: SignalStateType): Promise<CandidateMemorySignal> {
    const parsedState = parseSignalState(state);

    try {
      const result = this.updateStateStatement.run(parsedState, signalId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Signal ${signalId} was not found.`);
      }

      const signal = await this.getById(signalId);

      if (signal === null) {
        throw new StorageError("NOT_FOUND", `Signal ${signalId} was not found after update.`);
      }

      return signal;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update signal state for ${signalId}.`, error);
    }
  }
}

function parseSignal(signal: CandidateMemorySignal): CandidateMemorySignal {
  try {
    return CandidateMemorySignalSchema.parse(signal);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate candidate signal.", error);
  }
}

function parseSignalRow(row: SignalRow): CandidateMemorySignal {
  try {
    return CandidateMemorySignalSchema.parse({
      signal_id: row.signal_id,
      workspace_id: row.workspace_id,
      run_id: row.run_id,
      surface_id: row.surface_id,
      source: row.source,
      signal_kind: row.signal_kind,
      signal_state: row.signal_state,
      object_kind: row.object_kind,
      scope_hint: row.scope_hint,
      domain_tags: JSON.parse(row.domain_tags_json),
      confidence: row.confidence,
      evidence_refs: JSON.parse(row.evidence_refs_json),
      source_memory_refs: JSON.parse(row.source_memory_refs_json),
      supersedes_refs: JSON.parse(row.supersedes_refs_json),
      exception_to_refs: JSON.parse(row.exception_to_refs_json),
      contradicts_refs: JSON.parse(row.contradicts_refs_json),
      incompatible_with_refs: JSON.parse(row.incompatible_with_refs_json),
      raw_payload: JSON.parse(row.raw_payload_json),
      created_at: row.created_at
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate signal row.", error);
  }
}

function parseSignalState(state: SignalStateType): SignalStateType {
  try {
    return SignalStateSchema.parse(state);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate signal state.", error);
  }
}
