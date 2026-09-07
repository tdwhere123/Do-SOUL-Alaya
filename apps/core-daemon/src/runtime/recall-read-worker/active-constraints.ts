import { SoulActiveConstraintSchema, type BoundedActiveConstraintsRequest } from "@do-soul/alaya-protocol";
import { snapshotIdFromPin } from "@do-soul/alaya-core";
import { findActiveConstraints, readBoundedActiveConstraints, SqliteGovernancePathReader,
  SqliteIndexedRecallProjection, type StorageDatabase } from "@do-soul/alaya-storage";
import type { RecallPathReadPorts } from "../recall/recall-path-readers.js";

export function createBoundedActiveConstraintsReader(database: StorageDatabase) {
  const paths = new SqliteGovernancePathReader(database);
  paths.prepareIndex();
  const projection = new SqliteIndexedRecallProjection(database.connection);
  return (request: Readonly<BoundedActiveConstraintsRequest>) => database.connection.transaction(() => {
    if (request.nativeLimit < 3 || request.byteLimit < 2048) throw new Error("active constraints snapshot allowance unavailable");
    const pin = projection.observablePin(request.workspaceId);
    const pinBytes = Buffer.byteLength(JSON.stringify(pin), "utf8");
    const snapshot = snapshotIdFromPin(request.workspaceId, pin);
    if (request.snapshotId !== undefined && request.snapshotId !== snapshot) throw new Error("active constraints snapshot mismatch");
    const result = readBoundedActiveConstraints(database, {
      ...request, snapshotId: snapshot, nativeLimit: request.nativeLimit - 3, byteLimit: request.byteLimit - pinBytes
    },
      (input) => paths.read(input));
    const response = { ...result, work: {
      ...result.work, native_visits: result.work.native_visits + 3, bytes_read: result.work.bytes_read + pinBytes
    } };
    for (let pass = 0; pass < 3; pass += 1) {
      response.work.retained_bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
    }
    return response;
  })();
}

export async function runWorkerActiveConstraints(input: Readonly<{
  readonly payload: Record<string, unknown>;
  readonly memoryRepo: Parameters<typeof findActiveConstraints>[0]["memoryRepo"];
  readonly claimFormRepo: Parameters<typeof findActiveConstraints>[0]["claimFormRepo"];
  readonly pathReadPorts: RecallPathReadPorts;
}>): Promise<Readonly<{
  readonly constraints: readonly unknown[];
  readonly total_count: number;
}>> {
  const workspaceId = readString(input.payload.workspaceId, "workspaceId");
  const asOf = readOptionalString(input.payload.asOf, "asOf");
  const result = await findActiveConstraints({
    workspaceId,
    memoryRepo: input.memoryRepo,
    claimFormRepo: input.claimFormRepo,
    pathRelationRepo: {
      findActiveAll: async () => ({
        relations: await input.pathReadPorts.findActiveByWorkspace(
          workspaceId,
          asOf === undefined ? {} : { asOf }
        ),
        truncated: false
      })
    },
    cap: readNullableNumber(input.payload.cap, "cap")
  });
  return Object.freeze({
    constraints: Object.freeze(result.constraints.map(toActiveConstraint)),
    total_count: result.total_count
  });
}

function toActiveConstraint(record: Awaited<ReturnType<typeof findActiveConstraints>>["constraints"][number]) {
  return SoulActiveConstraintSchema.parse({
    object_id: record.memory.object_id,
    object_kind: record.memory.object_kind,
    content: record.memory.content,
    dimension: record.memory.dimension,
    scope_class: record.memory.scope_class,
    governance_state: {
      claim_status: record.claim_status,
      governance_class: record.governance_class,
      source_channels: record.source_channels
    }
  });
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`worker payload ${name} must be a string`);
  return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : readString(value, name);
}

function readNullableNumber(value: unknown, name: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker payload ${name} must be a finite number`);
  }
  return value;
}
