import { parentPort, workerData } from "node:worker_threads";
import {
  MemoryDimensionSchema,
  type PathAnchorRef,
  ScopeClassSchema,
  StorageTierSchema
} from "@do-soul/alaya-protocol";
import { EventPublisher, RelationAssertionService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRelationAssertionRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteTemporalPathProjectionReader
} from "@do-soul/alaya-storage";
import type {
  RecallReadWorkerRequest,
  RecallReadWorkerResponse
} from "./recall-read-worker/protocol.js";
import {
  createRecallPathReadPorts,
  createRecallTemporalProjectionEnsurer,
  type RecallPathProjectionReadOptions
} from "./recall-path-readers.js";
import { runWorkerActiveConstraints } from "./recall-read-worker/active-constraints.js";
import {
  findMemoryEntriesByWorkspaceId,
  readRecallTierWindowQuery
} from "./recall-read-worker/memory-window.js";
import { postRecallTierWindowChunks } from "./recall-read-worker/tier-window-stream.js";

if (parentPort === null) {
  throw new Error("recall read worker requires a parent port");
}

const databaseFilename = readDatabaseFilename(workerData);
const temporalProjectionSelected = readTemporalProjectionSelected(workerData);
const database = initDatabase({ filename: databaseFilename });
const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
const claimFormRepo = new SqliteClaimFormRepo(database);
const eventLogRepo = new SqliteEventLogRepo(database);
const recallPathReadPorts = temporalProjectionSelected
  ? createRecallPathReadPorts({
      temporalProjectionSelected,
      temporalPathProjectionReader: new SqliteTemporalPathProjectionReader(
        new SqliteRelationAssertionRepo(database)
      ),
      ensureTemporalProjection: createRecallTemporalProjectionEnsurer(
        new RelationAssertionService({
          repo: new SqliteRelationAssertionRepo(database),
          eventPublisher: new EventPublisher({
            eventLogRepo,
            runHotStateService: { apply: () => undefined },
            runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
          }),
          eventHistory: eventLogRepo
        })
      )
    })
  : createRecallPathReadPorts({
      legacyPathReader: new SqlitePathRelationRepo(database)
    });
const MAX_WORKER_PAGE_LIMIT = 5000;
let closed = false;

type WorkerKeywordSearchQuery = Readonly<{
  readonly queryText: string;
  readonly limit: number;
}>;

parentPort.on("message", (message: unknown) => {
  void handleRequest(message);
});

async function handleRequest(message: unknown): Promise<void> {
  if (!isRecallReadWorkerRequest(message)) {
    const id = readNumericMessageId(message);
    if (id !== null) {
      // Bound rejection to this id so the client does not wait for timeout cascade.
      postResponse({
        id,
        ok: false,
        error: {
          name: "Error",
          message: "invalid recall read worker request"
        }
      });
    }
    return;
  }
  try {
    if (message.operation === "memory.findRecallTierWindow") {
      const result = await memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(asPayload(message.payload))
      );
      await postRecallTierWindowChunks(message.id, result, postResponse);
      return;
    }
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
    case "ready":
      return null;
    case "memory.findByWorkspaceId":
    case "memory.findByDimension":
    case "memory.findByScopeClass":
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
    case "memory.findByEvidenceRefs":
    case "memory.findByIds":
      return await runMemoryOperation(request.operation, payload);
    case "evidence.searchByKeyword":
    case "evidence.searchManyByKeyword":
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
    case "constraints.findActive":
      return await runWorkerActiveConstraints({
        payload,
        memoryRepo: memoryEntryRepo,
        claimFormRepo,
        pathReadPorts: recallPathReadPorts
      });
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
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
      return await runMemorySearchOperation(operation, payload);
    case "memory.findByWorkspaceId":
      return await findMemoryEntriesByWorkspaceId(
        memoryEntryRepo,
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

async function runMemorySearchOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `memory.search${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "memory.searchManyByKeywordWithinObjectIds") {
    return await searchManyMemoryKeywordsWithinObjectIds(payload);
  }
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const limit = readNumber(payload.limit, "limit");
  if (operation === "memory.searchByKeyword") {
    return await memoryEntryRepo.searchByKeyword(
      workspaceId,
      readString(payload.queryText, "queryText"),
      limit
    );
  }
  if (
    operation === "memory.searchByKeywordWithinTier" ||
    operation === "memory.searchByAnchorWithinTier"
  ) {
    return await runTierScopedMemorySearch(operation, payload, workspaceId, limit);
  }
  const objectIds = readStringArray(payload.objectIds, "objectIds");
  if (operation === "memory.searchByKeywordWithinObjectIds") {
    return await memoryEntryRepo.searchByKeywordWithinObjectIds(
      workspaceId,
      readString(payload.queryText, "queryText"),
      limit,
      objectIds
    );
  }
  return await memoryEntryRepo.searchByAnchorWithinObjectIds(
    workspaceId,
    readStringArray(payload.anchorTokens, "anchorTokens"),
    readStringArray(payload.optionalTokens, "optionalTokens"),
    limit,
    objectIds
  );
}

async function runTierScopedMemorySearch(
  operation: "memory.searchByKeywordWithinTier" | "memory.searchByAnchorWithinTier",
  payload: Record<string, unknown>,
  workspaceId: string,
  limit: number
) {
  const tier = StorageTierSchema.parse(payload.tier);
  if (operation === "memory.searchByKeywordWithinTier") {
    const queryText = readString(payload.queryText, "queryText");
    return await memoryEntryRepo.searchByKeywordWithinTier(workspaceId, queryText, limit, tier);
  }
  const anchorTokens = readStringArray(payload.anchorTokens, "anchorTokens");
  const optionalTokens = readStringArray(payload.optionalTokens, "optionalTokens");
  return await memoryEntryRepo.searchByAnchorWithinTier(
    workspaceId, anchorTokens, optionalTokens, limit, tier
  );
}

async function searchManyMemoryKeywordsWithinObjectIds(
  payload: Record<string, unknown>
) {
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const objectIds = readStringArray(payload.objectIds, "objectIds");
  const queries = readKeywordSearchBatchQueries(payload.queries);
  return runOrderedKeywordSearchBatch(queries, (query) =>
    memoryEntryRepo.searchByKeywordWithinObjectIds(
      workspaceId, query.queryText, query.limit, objectIds
    ));
}

async function runEvidenceOperation(
  operation: Extract<RecallReadWorkerRequest["operation"], `evidence.${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "evidence.searchManyByKeyword") {
    return searchManyEvidenceKeywords(payload);
  }
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

async function searchManyEvidenceKeywords(
  payload: Record<string, unknown>
) {
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const queries = readKeywordSearchBatchQueries(payload.queries);
  return runOrderedKeywordSearchBatch(queries, (query) =>
    evidenceCapsuleRepo.searchByKeyword(workspaceId, query.queryText, query.limit));
}

async function runOrderedKeywordSearchBatch<Result>(
  queries: readonly WorkerKeywordSearchQuery[],
  searchOne: (query: WorkerKeywordSearchQuery) => Promise<readonly Result[]>
): Promise<readonly (readonly Result[])[]> {
  const batches: (readonly Result[])[] = [];
  for (const query of queries) batches.push(await searchOne(query));
  return batches;
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
  const options = readPathProjectionReadOptions(payload);
  if (operation === "path.findByAnchors") {
    return await recallPathReadPorts.pathExpansionPort.findByAnchors(
      readString(payload.workspaceId, "workspaceId"),
      readAnchorRefs(payload.anchorRefs),
      options
    );
  }
  if (operation === "pathPlasticity.getStrengthByMemoryId") {
    const strengths = await recallPathReadPorts.pathPlasticityPort.getStrengthByMemoryId(
      readString(payload.workspaceId, "workspaceId"),
      readStringArray(payload.memoryIds, "memoryIds"),
      options
    );
    return [...strengths.entries()];
  }

  return await recallPathReadPorts.pathExpansionPort.findByTimeConcernWindowDigests(
    readString(payload.workspaceId, "workspaceId"),
    readStringArray(payload.windowDigests, "windowDigests"),
    options
  );
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

function readNumericMessageId(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function readDatabaseFilename(value: unknown): string {
  const payload = asPayload(value);
  return readString(payload.databaseFilename, "databaseFilename");
}

function readTemporalProjectionSelected(value: unknown): boolean {
  const payload = asPayload(value);
  const selected = payload.temporalProjectionSelected;
  if (selected === undefined) {
    return false;
  }
  if (typeof selected !== "boolean") {
    throw new Error("worker payload temporalProjectionSelected must be a boolean");
  }
  return selected;
}

function readPathProjectionReadOptions(
  payload: Record<string, unknown>
): RecallPathProjectionReadOptions {
  if (payload.asOf === undefined) {
    return Object.freeze({});
  }
  return Object.freeze({ asOf: readString(payload.asOf, "asOf") });
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

function readKeywordSearchBatchQueries(
  value: unknown
): readonly WorkerKeywordSearchQuery[] {
  if (!Array.isArray(value)) {
    throw new Error("worker payload queries must be an array");
  }
  return value.map((item, index) => {
    const query = asPayload(item);
    return {
      queryText: readString(query.queryText, `queries[${index}].queryText`),
      limit: readNumber(query.limit, `queries[${index}].limit`)
    };
  });
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
