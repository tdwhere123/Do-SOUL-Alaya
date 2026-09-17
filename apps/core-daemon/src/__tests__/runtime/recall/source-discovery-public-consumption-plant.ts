import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  RecallService,
  type ConditionalFieldExecutionReceipt
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase,
  SqliteFieldSourceRecordRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { OfficialApiExtractionRequest } from "@do-soul/alaya-soul";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { MEM, NOW, RUN, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  canaryDistractorRelation,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { publicIdentities } from "./source-discovery-public-consumer.js";
import {
  insertBoundGist,
  publicSearchRequest,
  tapRecallReceipts,
  type ResultView
} from "./source-discovery-public-consumption.js";
import {
  bindReceivedSourceInterpretationPayload,
  publishBoundPublicSources,
  requireCompletePublicBind,
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
    ...hashedRecord(WS, canary.intended, "intended"),
    ...(canary.event_time === undefined ? {} : { event_time: canary.event_time })
  });
  const distractorInput = Array.from({ length: 128 }, (_, index) =>
    hashedRecord(WS, canary.distractor, `distractor-${index}`)).find((row) =>
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
  setup: (planted: PlantedSources) => T,
  run: PlantedHandler<PlantedSources & T>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-bound-public-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  let handedOff = false;
  try {
    const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
    const sourceRow = records.insert(hashedRecord(WS, sourceBody, "bound-source"));
    const distractor = records.insert(hashedRecord(WS, distractorBody, "distractor-source"));
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
    const extra = setup(planted);
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
  }>,
  run: PlantedHandler<PlantedBound>
): Promise<void> {
  await withPlantedSourceWorker(input.sourceBody, input.distractorBody, (planted) => {
    const bind = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({
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
  const first = records.insert(hashedRecord(WS, firstBody, "first-omitted"));
  const second = records.insert(hashedRecord(WS, secondBody, "second-omitted"));
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
        await client.ready();
        const probeAt = receipts.length;
        const firstPage = await handler(
          publicSearchRequest(canary, "proposal", "source_only", "canonical"),
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
    publicFirst: hashedRecord(WS, publicFirstBody, firstKey),
    later: hashedRecord(WS, laterBody, laterKey)
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

async function runPlantedHandler<T extends { readonly database: StorageDatabase; readonly filename: string }>(
  filename: string,
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  planted: T,
  run: PlantedHandler<T>
): Promise<void> {
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
