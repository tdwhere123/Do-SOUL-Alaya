import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  RecallService,
  SourceIndexLifecycle,
  type ConditionalFieldExecutionReceipt
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase,
  SqliteFieldSourceRecordRepo,
  SqliteSourceIndexRepository,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { OfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import {
  BUDGET as SOURCE_INDEX_BUDGET,
  configuration as sourceIndexConfiguration
} from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { MEM, NOW, RUN, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  canaryDistractorRelation,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { publicIdentities } from "./source-discovery-public-consumer.js";
import { bindNativeControl } from "./source-discovery-native-control.js";
import {
  insertBoundGist,
  LIVE_ORDINARY_ENUMERATION,
  publicSearchRequest,
  tapRecallReceipts,
  type ResultView
} from "./source-discovery-public-consumption.js";
import {
  bindReceivedSourceInterpretationPayload,
  publishBoundPublicSources,
  requireCompletePublicBind,
  type BoundPublicProvenance,
  type BoundPublicReceive,
  type BoundPublicSource
} from "./source-discovery-admitted-public-publication.js";

export type PlantedIntended = Readonly<{
  readonly database: StorageDatabase;
  readonly filename: string;
  readonly intendedId: string;
}>;

export type PlantedOmittedPair = Readonly<{
  readonly database: StorageDatabase;
  readonly filename: string;
  readonly first_id: string;
  readonly second_id: string;
  readonly first_body: string;
  readonly second_body: string;
}>;

export type PlantedPublicPair = Readonly<{
  readonly database: StorageDatabase;
  readonly filename: string;
  readonly public_first_id: string;
  readonly later_id: string;
  readonly public_first_body: string;
  readonly later_body: string;
}>;

export type PlantedSources = Readonly<{
  readonly database: StorageDatabase;
  readonly filename: string;
  readonly sourceId: string;
  readonly distractorId: string;
  readonly source: BoundPublicSource;
}>;

export type PlantedBound = PlantedSources & Readonly<{
  readonly bind: Extract<BoundPublicReceive, { readonly status: "complete" }>;
  readonly gistObjectIds: readonly string[];
}>;

type PlantedHandler<T> = (
  planted: T,
  handler: ReturnType<typeof createRecallHandler>,
  receipts: ConditionalFieldExecutionReceipt[],
  client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>
) => Promise<void>;

/** Windows can keep WAL/SHM after better-sqlite3 close(); worker reopen must wait. */
export async function awaitWorkerAfterMainSqliteClose(
  client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>
): Promise<void> {
  if (process.platform !== "win32") {
    await client.ready();
    return;
  }
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await client.ready();
      return;
    } catch (error) {
      last = error;
      await sleep(100);
    }
  }
  throw last;
}

export async function withPlantedWorker(
  canary: CanaryCase,
  view: ResultView,
  intendedFirst: boolean,
  run: PlantedHandler<PlantedIntended>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-public-consumption-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const intended = records.insert({
    ...governedSourceRecord(canary.intended, "intended"),
    ...(canary.event_time === undefined ? {} : { event_time: canary.event_time })
  });
  const distractorInput = Array.from({ length: 128 }, (_, index) =>
    governedSourceRecord(canary.distractor, `distractor-${index}`)).find((row) =>
      (intended.record_id < row.record_id) === intendedFirst);
  if (distractorInput === undefined) throw new Error("Could not plant requested physical order");
  const distractor = records.insert(distractorInput);
  insertBoundGist(slice.database, `gist-${intended.record_id}`, canary.intended, intended.record_id,
    intended.content_digest, intended.evidence_object_id, canary.sketch, WS, RUN, NOW);
  insertBoundGist(slice.database, `gist-${distractor.record_id}`, canary.distractor, distractor.record_id,
    distractor.content_digest, distractor.evidence_object_id, canaryDistractorRelation(canary), WS, RUN, NOW);
  if (view !== "source_only") {
    await slice.writeMemory(MEM.r, canary.original_query, MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, `${canary.original_query} second memory`, MemoryDimension.FACT);
  }
  await runPlantedHandler(filename, slice, { database: slice.database, filename, intendedId: intended.record_id }, run);
}

export async function withPlantedSourceWorker<T extends object>(
  sourceBody: string,
  distractorBody: string,
  setup: (planted: PlantedSources) => T | Promise<T>,
  run: PlantedHandler<PlantedSources & T>,
  options?: Readonly<{ readonly memoryText?: string; readonly sourceFirst?: boolean; readonly sourceId?: string }>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-bound-public-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  let handedOff = false;
  try {
    const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
    const sourceRow = records.insert(governedSourceRecord(sourceBody, options?.sourceId ?? "bound-source"));
    const distractorInput = options?.sourceFirst === undefined
      ? governedSourceRecord(distractorBody, "distractor-source")
      : Array.from({ length: 128 }, (_, index) => governedSourceRecord(distractorBody, `distractor-${index}`))
        .find((row) => (sourceRow.record_id < row.record_id) === options.sourceFirst);
    if (distractorInput === undefined) throw new Error("requested source order cannot be planted");
    const distractor = records.insert(distractorInput);
    if (options?.memoryText !== undefined) {
      await slice.writeMemory(MEM.r, options.memoryText, MemoryDimension.FACT);
      await slice.writeMemory(MEM.c, `${options.memoryText} second memory`, MemoryDimension.FACT);
    }
    const planted: PlantedSources = {
      database: slice.database,
      filename,
      sourceId: sourceRow.record_id,
      distractorId: distractor.record_id,
      source: {
        body: sourceBody,
        rootId: sourceRow.record_id,
        digest: sourceRow.content_digest,
        evidenceObjectId: sourceRow.evidence_object_id
      }
    };
    const extra = await setup(planted);
    handedOff = true;
    await runPlantedHandler(filename, slice, { ...planted, ...extra }, run);
  } finally {
    if (!handedOff) {
      try { slice.database.close(); } catch { /* closed */ }
      closeCachedDatabase(filename);
      await rm(dirname(filename), { recursive: true, force: true });
    }
  }
}

export async function withBoundPublicWorker(
  input: Readonly<{
    readonly sourceBody: string;
    readonly distractorBody: string;
    readonly rawJson: string;
    readonly request: OfficialApiExtractionRequest;
    readonly provenance?: Extract<BoundPublicProvenance, "payload" | "native-admitted-control">;
  }>,
  run: PlantedHandler<PlantedBound>
): Promise<void> {
  await withPlantedSourceWorker(input.sourceBody, input.distractorBody, (planted) => {
    const receive = input.provenance === "native-admitted-control" ? bindNativeControl : bindReceivedSourceInterpretationPayload;
    const bind = requireCompletePublicBind(receive({
      rawJson: input.rawJson,
      sourceCorpus: input.sourceBody,
      artifactKey: `bound-${planted.sourceId}`,
      request: input.request
    }));
    const published = publishBoundPublicSources({
      database: planted.database,
      source: planted.source,
      workspaceId: WS,
      runId: RUN,
      now: NOW,
      bind
    });
    return { bind, gistObjectIds: published.gist_object_ids };
  }, run);
}

export async function withOmittedPairWorker(
  canary: CanaryCase,
  firstBody: string,
  secondBody: string,
  run: PlantedHandler<PlantedOmittedPair>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-public-omitted-pair-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const first = records.insert(governedSourceRecord(firstBody, "first-omitted"));
  const second = records.insert(governedSourceRecord(secondBody, "second-omitted"));
  insertBoundGist(slice.database, `gist-${first.record_id}`, canary.intended, first.record_id,
    first.content_digest, first.evidence_object_id, canary.sketch, WS, RUN, NOW);
  insertBoundGist(slice.database, `gist-${second.record_id}`, canary.intended, second.record_id,
    second.content_digest, second.evidence_object_id, canary.sketch, WS, RUN, NOW);
  await runPlantedHandler(filename, slice, {
    database: slice.database,
    filename,
    first_id: first.record_id,
    second_id: second.record_id,
    first_body: firstBody,
    second_body: secondBody
  }, run);
}

export async function withPublicOrderedPairWorker(
  canary: CanaryCase,
  publicFirstBody: string,
  laterBody: string,
  run: PlantedHandler<PlantedPublicPair>
): Promise<void> {
  let lastObserved: string | "unavailable" = "unavailable";
  for (const attempt of publicPairAttempts(publicFirstBody, laterBody)) {
    let matched = false;
    await withInsertedPublicPair(canary, attempt.publicFirst, attempt.later, publicFirstBody, laterBody,
      async (planted, handler, receipts, client) => {
        planted.database.close();
        closeCachedDatabase(planted.filename);
        await awaitWorkerAfterMainSqliteClose(client);
        const probeAt = receipts.length;
        const firstPage = await handler(
          publicSearchRequest(canary, "proposal", "source_only", LIVE_ORDINARY_ENUMERATION),
          { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" }
        );
        lastObserved = publicIdentities(firstPage)[0] ?? "unavailable";
        receipts.length = probeAt;
        if (lastObserved !== planted.public_first_id) return;
        matched = true;
        await run(planted, handler, receipts, client);
      });
    if (matched) return;
  }
  throw new Error(
    `Could not plant public-first body as first_page_identities[0]; last observed ${lastObserved}`
  );
}

function publicPairAttempts(
  publicFirstBody: string,
  laterBody: string
): ReadonlyArray<Readonly<{
  readonly publicFirst: ReturnType<typeof hashedRecord>;
  readonly later: ReturnType<typeof hashedRecord>;
}>> {
  const keys: ReadonlyArray<readonly [string, string]> = [
    ["second-omitted", "first-omitted"],
    ["first-omitted", "second-omitted"],
    ["public-first", "public-later"],
    ["public-later", "public-first"],
    ...Array.from({ length: 12 }, (_, index) => [`src-a-${index}`, `src-b-${index}`] as const)
  ];
  return keys.map(([firstKey, laterKey]) => ({
    publicFirst: governedSourceRecord(publicFirstBody, firstKey),
    later: governedSourceRecord(laterBody, laterKey)
  }));
}

async function withInsertedPublicPair(
  canary: CanaryCase,
  publicFirstInput: ReturnType<typeof hashedRecord>,
  laterInput: ReturnType<typeof hashedRecord>,
  publicFirstBody: string,
  laterBody: string,
  run: PlantedHandler<PlantedPublicPair>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-public-ordered-pair-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const publicFirst = records.insert(publicFirstInput);
  const later = records.insert(laterInput);
  insertBoundGist(slice.database, `gist-${publicFirst.record_id}`, canary.intended, publicFirst.record_id,
    publicFirst.content_digest, publicFirst.evidence_object_id, canary.sketch, WS, RUN, NOW);
  insertBoundGist(slice.database, `gist-${later.record_id}`, canary.intended, later.record_id,
    later.content_digest, later.evidence_object_id, canary.sketch, WS, RUN, NOW);
  await runPlantedHandler(filename, slice, {
    database: slice.database,
    filename,
    public_first_id: publicFirst.record_id,
    later_id: later.record_id,
    public_first_body: publicFirstBody,
    later_body: laterBody
  }, run);
}

/** Native admission rejects unscoped sources; intended and distractor share the same governed class. */
function governedSourceRecord(body: string, sourceId: string): ReturnType<typeof hashedRecord> {
  return { ...hashedRecord(WS, body, sourceId), scope_class: "project" };
}

/** Native public membership reads source_index_text FTS, not source_records or gists.
 * Prepare every captured current root equally so intended and distractor share the same prerequisite.
 */
function preparePlantedNativeLexicalIndex(database: StorageDatabase, workspaceId: string): void {
  const repository = new SqliteSourceIndexRepository(database, fieldSha256);
  const lifecycle = new SourceIndexLifecycle(repository, fieldSha256);
  const generation = lifecycle.begin(lifecycle.select(workspaceId, sourceIndexConfiguration()));
  let captured = lifecycle.capture(workspaceId, generation.generation_id, 128, SOURCE_INDEX_BUDGET);
  while (!captured.generation.enumeration_complete) {
    if (captured.added === 0) {
      throw new Error(`planted native index capture stalled: ${JSON.stringify({
        reason: captured.generation.reason,
        status: captured.generation.status,
        target_count: captured.generation.target_count
      })}`);
    }
    captured = lifecycle.capture(workspaceId, generation.generation_id, 128, SOURCE_INDEX_BUDGET);
  }
  const targets: Array<ReturnType<SqliteSourceIndexRepository["listTargets"]>[number]> = [];
  let afterRootKey: string | null = null;
  for (;;) {
    const page = repository.listTargets(workspaceId, generation.generation_id, afterRootKey, 128);
    if (page.length === 0) break;
    targets.push(...page);
    afterRootKey = page.at(-1)!.root_key;
  }
  if (targets.length === 0) {
    throw new Error("planted native index captured no current sources");
  }
  for (const target of targets) {
    const prepared = lifecycle.prepare(workspaceId, generation.generation_id, target.root_key, SOURCE_INDEX_BUDGET);
    if (prepared.status === "ready") continue;
    if (prepared.status === "partial" && prepared.reason === "window_capacity") continue;
    throw new Error(`planted native lexical prepare failed: ${JSON.stringify({
      root_key: target.root_key,
      status: prepared.status,
      reason: "reason" in prepared ? prepared.reason : null
    })}`);
  }
}

async function runPlantedHandler<T extends { readonly database: StorageDatabase; readonly filename: string }>(
  filename: string,
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  planted: T,
  run: PlantedHandler<T>
): Promise<void> {
  preparePlantedNativeLexicalIndex(slice.database, WS);
  const receipts: ConditionalFieldExecutionReceipt[] = [];
  const client = createRecallReadWorkerClient({
    databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
  })!;
  const service = tapRecallReceipts(new RecallService({
    ...createDependencies().dependencies,
    now: () => NOW,
    conditionalFieldPort: client.conditionalFieldPort,
    activeConstraintsPort: client.activeConstraintsPort,
    readSnapshot: client.readSnapshot
  }), receipts);
  const handler = createRecallHandler({
    deps: { ...createDeps(), recallService: service },
    now: () => NOW,
    generateId: randomUUID,
    warn: () => undefined
  });
  try {
    await run(planted, handler, receipts, client);
  } finally {
    await client.close();
    try { slice.database.close(); } catch { /* already closed after native observe */ }
    closeCachedDatabase(filename);
    await rm(dirname(filename), { recursive: true, force: true });
  }
}
