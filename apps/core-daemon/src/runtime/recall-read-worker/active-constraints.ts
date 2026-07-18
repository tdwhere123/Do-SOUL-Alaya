import { SoulActiveConstraintSchema } from "@do-soul/alaya-protocol";
import { findActiveConstraints } from "@do-soul/alaya-storage";
import type { RecallPathReadPorts } from "../recall-path-readers.js";

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
      findActiveAll: async () =>
        await input.pathReadPorts.findActiveByWorkspace(
          workspaceId,
          asOf === undefined ? {} : { asOf }
        )
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
