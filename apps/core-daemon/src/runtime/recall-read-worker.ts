import { parentPort, workerData } from "node:worker_threads";
import {
  MemoryDimensionSchema,
  isPathActiveForRecall,
  type PathAnchorRef,
  type PathRelation,
  ScopeClassSchema,
  StorageTierSchema,
  type StorageTier
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteSynthesisCapsuleRepo
} from "@do-soul/alaya-storage";
import type {
  RecallReadWorkerRequest,
  RecallReadWorkerResponse
} from "./recall-read-worker-client.js";
import { normalizeRecallTimeConcernWindowDigest } from "./garden-compute-support.js";

if (parentPort === null) {
  throw new Error("recall read worker requires a parent port");
}

const databaseFilename = readDatabaseFilename(workerData);
const database = initDatabase({ filename: databaseFilename });
const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
const pathRelationRepo = new SqlitePathRelationRepo(database);
const MEMORY_ENTRY_PAGE_LIMIT = 500;
const MAX_WORKER_PAGE_LIMIT = 5000;
let closed = false;

parentPort.on("message", (message: unknown) => {
  void handleRequest(message);
});

async function handleRequest(message: unknown): Promise<void> {
  if (!isRecallReadWorkerRequest(message)) {
    return;
  }
  try {
    const result = await runOperation(message);
    postResponse({ id: message.id, ok: true, result });
  } catch (error) {
    postResponse({
      id: message.id,
      ok: false,
      error: serializeError(error)
    });
  }
}

async function runOperation(request: RecallReadWorkerRequest): Promise<unknown> {
  if (closed && request.operation !== "close") {
    throw new Error("recall read worker database is closed");
  }
  const payload = asPayload(request.payload);
  switch (request.operation) {
    case "memory.findByWorkspaceId":
    case "memory.findByDimension":
    case "memory.findByScopeClass":
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.findByEvidenceRefs":
    case "memory.findByIds":
      return await runMemoryOperation(request.operation, payload);
    case "evidence.searchByKeyword":
    case "evidence.findByIds":
    case "evidence.findSourceAnchorsByIds":
      return await runEvidenceOperation(request.operation, payload);
    case "synthesis.searchByKeyword":
    case "synthesis.findByIds":
      return await runSynthesisOperation(request.operation, payload);
    case "path.findByAnchors":
    case "path.findByTimeConcernWindowDigests":
    case "pathPlasticity.getStrengthByMemoryId":
      return await runPathOperation(request.operation, payload);
    case "close":
      database.close();
      closed = true;
      return null;
  }
}

async function runMemoryOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `memory.${string}`>,
  payload: Record<string, unknown>
) {
  switch (operation) {
    case "memory.findByWorkspaceId":
      return await findMemoryEntriesByWorkspaceId(
        readString(payload.workspaceId, "workspaceId"),
        payload.tier === undefined ? undefined : StorageTierSchema.parse(payload.tier),
        payload.page === undefined ? undefined : readPage(payload.page)
      );
    case "memory.findByDimension":
      return await memoryEntryRepo.findByDimension(
        readString(payload.workspaceId, "workspaceId"),
        MemoryDimensionSchema.parse(payload.dimension)
      );
    case "memory.findByScopeClass":
      return await memoryEntryRepo.findByScopeClass(
        readString(payload.workspaceId, "workspaceId"),
        ScopeClassSchema.parse(payload.scopeClass)
      );
    case "memory.searchByKeyword":
      return await memoryEntryRepo.searchByKeyword(
        readString(payload.workspaceId, "workspaceId"),
        readString(payload.queryText, "queryText"),
        readNumber(payload.limit, "limit")
      );
    case "memory.searchByKeywordWithinObjectIds":
      return await memoryEntryRepo.searchByKeywordWithinObjectIds(
        readString(payload.workspaceId, "workspaceId"),
        readString(payload.queryText, "queryText"),
        readNumber(payload.limit, "limit"),
        readStringArray(payload.objectIds, "objectIds")
      );
    case "memory.searchByAnchorWithinObjectIds":
      return await memoryEntryRepo.searchByAnchorWithinObjectIds(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.anchorTokens, "anchorTokens"),
        readStringArray(payload.optionalTokens, "optionalTokens"),
        readNumber(payload.limit, "limit"),
        readStringArray(payload.objectIds, "objectIds")
      );
    case "memory.findByEvidenceRefs":
      return await memoryEntryRepo.findByEvidenceRefs(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
      );
    case "memory.findByIds":
      return await memoryEntryRepo.findByIds(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.objectIds, "objectIds")
      );
  }
}

async function runEvidenceOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `evidence.${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "evidence.searchByKeyword") {
    return await evidenceCapsuleRepo.searchByKeyword(
      readString(payload.workspaceId, "workspaceId"),
      readString(payload.queryText, "queryText"),
      readNumber(payload.limit, "limit")
    );
  }

  const workspaceId = readString(payload.workspaceId, "workspaceId");
  if (operation === "evidence.findSourceAnchorsByIds") {
    return await evidenceCapsuleRepo.findSourceAnchorsByIds(
      workspaceId,
      readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
    );
  }
  return await evidenceCapsuleRepo.findByIds(
    workspaceId,
    readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
  );
}

async function runSynthesisOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `synthesis.${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "synthesis.searchByKeyword") {
    return await synthesisCapsuleRepo.searchByKeyword(
      readString(payload.workspaceId, "workspaceId"),
      readString(payload.queryText, "queryText"),
      readNumber(payload.limit, "limit")
    );
  }

  return await synthesisCapsuleRepo.findByIds(
    readString(payload.workspaceId, "workspaceId"),
    readStringArray(payload.objectIds, "objectIds")
  );
}

async function runPathOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `path${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "path.findByAnchors") {
    return await pathRelationRepo.findByAnchors(
      readString(payload.workspaceId, "workspaceId"),
      readAnchorRefs(payload.anchorRefs)
    );
  }
  if (operation === "pathPlasticity.getStrengthByMemoryId") {
    return await getStrengthByMemoryId(
      readString(payload.workspaceId, "workspaceId"),
      readStringArray(payload.memoryIds, "memoryIds")
    );
  }

  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const normalized = new Set(
    readStringArray(payload.windowDigests, "windowDigests").map(
      normalizeRecallTimeConcernWindowDigest
    )
  );
  const paths = await pathRelationRepo.findByWorkspaceAll(workspaceId);
  return paths.filter((path) =>
    isPathActiveForRecall(path.lifecycle.status) &&
    [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
      anchor.kind === "time_concern" &&
      normalized.has(normalizeRecallTimeConcernWindowDigest(anchor.window_digest))
    )
  );
}

async function findMemoryEntriesByWorkspaceId(
  workspaceId: string,
  tier: StorageTier | undefined,
  page: { readonly limit: number; readonly offset: number } | undefined
) {
  if (page === undefined || page.limit <= MEMORY_ENTRY_PAGE_LIMIT) {
    return await memoryEntryRepo.findByWorkspaceId(workspaceId, tier, page);
  }

  const rows = [];
  let remaining = page.limit;
  let offset = page.offset;
  while (remaining > 0) {
    const limit = Math.min(remaining, MEMORY_ENTRY_PAGE_LIMIT);
    const chunk = await memoryEntryRepo.findByWorkspaceId(workspaceId, tier, {
      limit,
      offset
    });
    rows.push(...chunk);
    if (chunk.length < limit) {
      break;
    }
    remaining -= chunk.length;
    offset += chunk.length;
  }
  return rows;
}

async function getStrengthByMemoryId(
  workspaceId: string,
  memoryIds: readonly string[]
): Promise<readonly (readonly [string, number])[]> {
  const result = new Map<string, number>();
  const uniqueMemoryIds = [...new Set(memoryIds)];
  if (uniqueMemoryIds.length === 0) {
    return [];
  }
  const requestedMemoryIds = new Set(uniqueMemoryIds);
  const paths = await pathRelationRepo.findByAnchors(
    workspaceId,
    uniqueMemoryIds.map((memoryId) => ({
      kind: "object",
      object_id: memoryId
    }))
  );

  for (const path of paths) {
    if (!isPathActiveForRecall(path.lifecycle.status)) {
      continue;
    }
    for (const memoryId of getDirectionEligibleObjectAnchorMemoryIds(path, requestedMemoryIds)) {
      const strongest = result.get(memoryId) ?? 0;
      if (path.plasticity_state.strength > strongest) {
        result.set(memoryId, path.plasticity_state.strength);
      }
    }
  }
  return [...result.entries()];
}

function getDirectionEligibleObjectAnchorMemoryIds(
  path: Readonly<PathRelation>,
  requestedMemoryIds: ReadonlySet<string>
): readonly string[] {
  const memoryIds = new Set<string>();
  const sourceAnchor = path.anchors.source_anchor;
  const targetAnchor = path.anchors.target_anchor;
  if (
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    sourceAnchor.kind === "object" &&
    requestedMemoryIds.has(sourceAnchor.object_id)
  ) {
    memoryIds.add(sourceAnchor.object_id);
  }
  if (
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    targetAnchor.kind === "object" &&
    requestedMemoryIds.has(targetAnchor.object_id)
  ) {
    memoryIds.add(targetAnchor.object_id);
  }
  return [...memoryIds];
}

function postResponse(response: RecallReadWorkerResponse): void {
  parentPort?.postMessage(response);
}

function serializeError(error: unknown): RecallReadWorkerResponse extends infer R
  ? R extends { readonly ok: false; readonly error: infer E }
    ? E
    : never
  : never {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack })
    };
  }
  return {
    name: "Error",
    message: String(error)
  };
}

function isRecallReadWorkerRequest(value: unknown): value is RecallReadWorkerRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    readonly id?: unknown;
    readonly operation?: unknown;
  };
  return typeof record.id === "number" && typeof record.operation === "string";
}

function readDatabaseFilename(value: unknown): string {
  const payload = asPayload(value);
  return readString(payload.databaseFilename, "databaseFilename");
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("worker payload must be an object");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`worker payload ${name} must be a string`);
  }
  return value;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker payload ${name} must be a finite number`);
  }
  return value;
}

function readStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`worker payload ${name} must be a string array`);
  }
  return value;
}

function readPage(value: unknown): { readonly limit: number; readonly offset: number } {
  const payload = asPayload(value);
  const limit = readNumber(payload.limit, "page.limit");
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_WORKER_PAGE_LIMIT) {
    throw new Error(`worker payload page.limit must be an integer between 0 and ${MAX_WORKER_PAGE_LIMIT}`);
  }
  const offset = readNumber(payload.offset, "page.offset");
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("worker payload page.offset must be a non-negative integer");
  }
  return {
    limit,
    offset
  };
}

function readAnchorRefs(value: unknown): readonly PathAnchorRef[] {
  if (!Array.isArray(value)) {
    throw new Error("worker payload anchorRefs must be an array");
  }
  return value as readonly PathAnchorRef[];
}
