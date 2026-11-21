import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => {
  expect(isolation.violations).toEqual([]);
  isolation.restore();
});

import {
  QueryInterpretationProposalSchema,
  SOURCE_DISCLOSURE_CODEC_VERSION,
  SOURCE_DISCLOSURE_DELTA_CODEC_VERSION,
  SoulMemorySearchRequestSchema,
  SoulMemorySearchResponseSchema,
  hashContentDigest,
  hashSourceRecordId,
  sourceIndexTarget,
  type HostSourceDependency,
  type SoulMemorySearchResponseWire
} from "@do-soul/alaya-protocol";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import { QUERY_PROPOSAL_CORE_PRODUCER_ID } from "../../../../../../packages/core/src/recall/conditional-field/query/query-proposal-producer-registry.js";
import {
  RecallService,
  createAuditedSourceAdmission,
  fieldContractSha256,
  snapshotIdFromPin
} from "@do-soul/alaya-core";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import {
  SqliteEventLogRepo,
  SqliteFieldSourceRecordRepo,
  SqliteRunRepo,
  SqliteSourceIndexRepository,
  SqliteWorkspaceRepo,
  closeCachedDatabase,
  initDatabase,
  prepareIndexedRecallProjection,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { PROVIDER_FREE_WORKER_IMPORT } from "./source-semantic-index-acquisition.test-support.js";

const WORKSPACE = "workspace-page-delta";
const RUN = "run-page-delta";
const NOW = "2026-09-18T00:00:00.000Z";
const BUDGET = {
  schema_version: 1 as const,
  work_units: 2_000_000,
  memory_bytes: 16_000_000,
  page_budget: 64,
  finalization_reserve: 10_000,
  min_envelope: 10
};

type Environment = {
  readonly database: StorageDatabase;
  readonly filename: string;
  readonly directory: string;
  readonly admission: ReturnType<typeof createAuditedSourceAdmission>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createEnvironment(): Promise<Environment> {
  assertBuiltWorker();
  const directory = await mkdtemp(join(tmpdir(), "alaya-page-delta-"));
  const filename = join(directory, "alaya.sqlite");
  const database = initDatabase({ filename });
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE,
    name: "workspace",
    root_path: directory,
    workspace_kind: "local_repo",
    default_engine_binding: null,
    workspace_state: "active"
  });
  await new SqliteRunRepo(database).create({
    run_id: RUN,
    workspace_id: WORKSPACE,
    title: "run",
    goal: null,
    run_mode: "chat",
    engine_binding_id: null,
    engine_class: null,
    run_state: "idle",
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const admission = createAuditedSourceAdmission({
    stores: field.stores,
    eventLogRepo,
    runtimeNotifier: { notifyEntry: async () => undefined },
    sha256: fieldContractSha256
  });
  cleanups.push(async () => {
    try {
      database.close();
    } catch {
      // Closed before worker handoff in some scenarios.
    }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  });
  return { database, filename, directory, admission };
}

function prepareLexicalAndOpenClient(env: Environment) {
  const records = new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256);
  const repository = new SqliteSourceIndexRepository(env.database, fieldContractSha256);
  for (const row of records.listByWorkspace(WORKSPACE)) {
    const target = {
      kind: "source_evidence" as const,
      workspace_id: WORKSPACE,
      root_kind: "source_record" as const,
      root_id: row.record_id,
      source_version: row.source_version,
      content_digest: row.content_digest,
      evidence_object_id: row.evidence_object_id
    };
    const native = sourceIndexTarget(target, row.source_id, Buffer.byteLength(row.source_body!, "utf8"));
    expect(repository.writeLexical(native, row.source_body!, { work: 100_000, native_bytes: 1_000_000 }).status).toBe("accepted");
  }
  prepareIndexedRecallProjection(env.database);

  process.execArgv.push(PROVIDER_FREE_WORKER_IMPORT);
  let client;
  try {
    client = createRecallReadWorkerClient({
      databaseFilename: env.filename,
      workerUrl: builtWorkerUrl,
      workerCount: 1
    })!;
  } finally {
    process.execArgv.splice(process.execArgv.lastIndexOf(PROVIDER_FREE_WORKER_IMPORT), 1);
  }
  cleanups.push(async () => {
    await client.close();
  });
  return client;
}

function createWireRecallHandler(client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>) {
  const service = new RecallService({
    ...createDependencies().dependencies,
    now: () => NOW,
    conditionalFieldPort: client.conditionalFieldPort,
    activeConstraintsPort: client.activeConstraintsPort,
    readSnapshot: client.readSnapshot
  });
  return createRecallHandler({
    deps: { ...createDeps(), recallService: service },
    now: () => NOW,
    generateId: randomUUID,
    warn: () => undefined
  });
}

async function admitMessageRecord(
  env: Environment,
  sourceId: string,
  segments: readonly Readonly<{
    readonly occurrenceId: string;
    readonly text: string;
    readonly role: "user" | "assistant";
    readonly semanticDependencies?: (selfRef: {
      source_id: string;
      root_id: string;
      source_version: string;
      content_digest: string;
    }) => readonly HostSourceDependency[];
  }>[]
) {
  const contentBytes = segments.map(segment => segment.text).join("");
  const sourceVersion = "1";
  const contentDigest = hashContentDigest(contentBytes, fieldContractSha256);
  const rootId = hashSourceRecordId(
    {
      source_id: sourceId,
      source_version: sourceVersion,
      content_digest: contentDigest,
      source_representation: { kind: "original_body" }
    },
    fieldContractSha256
  );

  let offset = 0;
  const hostOccurrences = segments.map(segment => {
    const end = offset + Buffer.byteLength(segment.text, "utf8");
    const span: readonly [number, number] = [offset, end];
    offset = end;
    const deps = segment.semanticDependencies?.({
      source_id: sourceId,
      root_id: rootId,
      source_version: sourceVersion,
      content_digest: contentDigest
    }) ?? [];
    return {
      occurrence_id: segment.occurrenceId,
      utf8_span: span,
      role: segment.role,
      channel: null,
      author_ref: null,
      container_ref: null,
      upstream_message_ref: null,
      upstream_position: null,
      completeness: "complete" as const,
      fidelity: "original_bytes" as const,
      semantic_dependencies: deps
    };
  });

  const admitted = await env.admission.admit(
    {
      workspace_id: WORKSPACE,
      source_id: sourceId,
      source_version: sourceVersion,
      content_bytes: contentBytes,
      evidence_object_id: null,
      recorded_at: NOW,
      event_time: NOW,
      valid_from: null,
      valid_to: null,
      speaker: "user",
      scope_class: "project",
      source_representation: { kind: "original_body" },
      spans: [],
      host_occurrences: hostOccurrences
    },
    {
      workspaceId: WORKSPACE,
      hostCapture: () => ({ namespace: "test", workspace_id: WORKSPACE, producer: "test", basis: "pinned_dataset" })
    }
  );
  return { rootId, sourceId, sourceVersion, contentDigest, admitted };
}

describe("daemon SQLite + built-worker Page-1 Delta + Next packing", () => {
  it("delivers Codec v2 page_delta slots over MCP soul.recall and decodes losslessly through SoulMemorySearchResponseSchema", async () => {
    const env = await createEnvironment();
    for (let i = 0; i < 6; i += 1) {
      const m1 = `needle r${i} ${"a".repeat(330)}`;
      const m2 = `tail r${i} ${"b".repeat(1691)}`;
      await admitMessageRecord(env, `delta-source-${i}`, [
        { occurrenceId: `occ-${i}-0`, role: "user", text: m1 },
        { occurrenceId: `occ-${i}-1`, role: "assistant", text: m2 }
      ]);
    }

    const client = prepareLexicalAndOpenClient(env);
    await client.ready();
    const handler = createWireRecallHandler(client);
    const context = { workspaceId: WORKSPACE, runId: RUN, agentTarget: "codex", sessionId: "session-delta" };
    const baseRequest = SoulMemorySearchRequestSchema.parse({
      query: "needle",
      max_results: 6,
      scope_class: "project",
      dimension: null,
      domain_tags: null,
      result_kind_view: "source_only",
      enumeration_policy: "native_query",
      protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true,
      supports_product_updates: true
    });

    const wirePage1: SoulMemorySearchResponseWire = await handler(baseRequest, context);
    expect(wirePage1.index?.representation.disclosure_codec).toBe("page_delta");
    // Literally 3 slots fit in max_total_tokens=2,000 (~630 B/slot); page_delta widens Page 1 to 4 slots.
    expect(wirePage1.results.length).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(wirePage1.results[0]?.source_disclosure)).toBe(true);
    expect(wirePage1.results[0]?.source_disclosure).toHaveLength(9);
    for (const slot of wirePage1.results.slice(1)) {
      expect(Array.isArray(slot.source_disclosure)).toBe(false);
      expect((slot.source_disclosure as { v: number }).v).toBe(SOURCE_DISCLOSURE_DELTA_CODEC_VERSION);
    }

    const decodedPage1 = SoulMemorySearchResponseSchema.parse(wirePage1);
    expect(decodedPage1.results).toHaveLength(wirePage1.results.length);
    for (const row of decodedPage1.results) {
      expect(Array.isArray(row.source_disclosure)).toBe(true);
      expect(row.source_disclosure?.[0]).toBe(SOURCE_DISCLOSURE_CODEC_VERSION);
    }

    expect(decodedPage1.index?.continuation).not.toBeNull();
    const wirePage2 = await handler(
      SoulMemorySearchRequestSchema.parse({ ...baseRequest, continuation: decodedPage1.index!.continuation }),
      context
    );
    const decodedPage2 = SoulMemorySearchResponseSchema.parse(wirePage2);
    expect(decodedPage2.results.length).toBeGreaterThanOrEqual(1);
    const page1Ids = new Set(decodedPage1.results.map(r => r.target.kind === "source_evidence" ? r.target.root_id : r.object_id));
    const page2Ids = decodedPage2.results.map(r => r.target.kind === "source_evidence" ? r.target.root_id : r.object_id);
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  }, 30_000);

  it("applies residual Next extension with SQLite host_occurrence_inventory dependencies and rejects denied prerequisite", async () => {
    const env = await createEnvironment();
    const m1 = `needle user prompt ${"p".repeat(381)}`; // 400 B: [0, 400)
    const m2 = `assistant reply ${"r".repeat(484)}`;    // 500 B: [400, 900)
    const m3 = `later turn ${"l".repeat(1989)}`;        // 2000 B: [900, 2900)
    const allowed = await admitMessageRecord(env, "next-allowed", [
      { occurrenceId: "occ-m1", role: "user", text: m1 },
      {
        occurrenceId: "occ-m2",
        role: "assistant",
        text: m2,
        semanticDependencies: self => [{ ...self, occurrence_id: "occ-m1" }]
      },
      { occurrenceId: "occ-m3", role: "user", text: m3 }
    ]);

    const protectedBody = "classified prerequisite outside project scope";
    const protectedDigest = hashContentDigest(protectedBody, fieldContractSha256);
    const protectedAdmitted = await env.admission.admit(
      {
        workspace_id: WORKSPACE,
        source_id: "protected-prereq",
        source_version: "1",
        content_bytes: protectedBody,
        evidence_object_id: null,
        recorded_at: NOW,
        event_time: NOW,
        valid_from: null,
        valid_to: null,
        speaker: "user",
        scope_class: "global_core",
        spans: [],
        host_occurrences: [{
          occurrence_id: "occ-protected",
          utf8_span: [0, Buffer.byteLength(protectedBody, "utf8")],
          role: "user",
          channel: null,
          author_ref: null,
          container_ref: null,
          upstream_message_ref: null,
          upstream_position: null,
          completeness: "complete",
          fidelity: "original_bytes",
          semantic_dependencies: []
        }]
      },
      {
        workspaceId: WORKSPACE,
        hostCapture: () => ({ namespace: "test", workspace_id: WORKSPACE, producer: "test", basis: "pinned_dataset" })
      }
    );
    const deniedRef: HostSourceDependency = {
      source_id: "protected-prereq",
      root_id: protectedAdmitted.record.identity,
      source_version: "1",
      content_digest: protectedDigest,
      occurrence_id: "occ-protected"
    };

    const r1 = `obsidian primary prompt ${"e".repeat(376)}`; // 400 B: [0, 400)
    const r2 = `dependent follow ${"f".repeat(383)}`;        // 400 B: [400, 800)
    const r3 = `trailing turn ${"t".repeat(1986)}`;          // 2000 B: [800, 2800)
    const rejected = await admitMessageRecord(env, "next-rejected", [
      { occurrenceId: "occ-r1", role: "user", text: r1 },
      {
        occurrenceId: "occ-r2",
        role: "assistant",
        text: r2,
        semanticDependencies: () => [deniedRef]
      },
      { occurrenceId: "occ-r3", role: "user", text: r3 }
    ]);

    const client = prepareLexicalAndOpenClient(env);
    await client.ready();
    const readersPort = client.conditionalFieldPort;
    const snapshotPin = createConditionalFieldObserverReaders(env.database).snapshotPin!(WORKSPACE);
    const snapshotId = snapshotIdFromPin(WORKSPACE, snapshotPin);

    const makeWorkerRequest = (queryText: string) => ({
      workspace_id: WORKSPACE,
      query_text: queryText,
      budget: { ...BUDGET, page_budget: 1 },
      snapshot_id: snapshotId,
      interpretation_clock: NOW,
      as_of: NOW,
      expires_at: "2099-01-01T00:00:00.000Z",
      authorized_scopes: ["project"],
      enumeration_policy: "native_query" as const,
      result_kind_view: "source_only" as const,
      interpretation_proposal: QueryInterpretationProposalSchema.parse({
        schema_version: 1,
        producer_id: QUERY_PROPOSAL_CORE_PRODUCER_ID,
        original_query_digest: digestOriginalQuery(queryText),
        evidence_conditions: [{ statement: queryText, speaker: "user", anchors: [] }]
      }),
      protocol_version: 1 as const,
      supported_result_kinds: ["memory_entry", "source_evidence"] as const,
      supports_source_evidence: true,
      supports_product_updates: true,
      delivery_budget: { max_total_tokens: 2_000, max_encoded_bytes: 4_000_000 }
    });

    const allowedReq = makeWorkerRequest("needle user prompt");
    const allowedRes = await readersPort.recall(allowedReq);
    expect(allowedRes.index.entries).toHaveLength(1);
    const allowedEntry = allowedRes.index.entries[0]!;
    expect(allowedEntry.target).toMatchObject({
      root_id: allowed.rootId,
      span: { content_start: 0, content_end: 900, content_complete: false }
    });
    const allowedPreviewKey = Object.keys(allowedRes.previews)[0]!;
    expect(allowedRes.previews[allowedPreviewKey]).toBe(`${m1}${m2}`);
    await readersPort.acknowledge!(allowedRes.preparation_id!, allowedRes.index, new Map(Object.entries(allowedRes.previews)));

    // Payload continuation resumes cleanly from the Next-extended content_end (900).
    const continuedRes = await readersPort.recall({
      ...allowedReq,
      continuation: allowedRes.index.continuation!,
      payload_continuation: {
        schema_version: 1,
        purpose: "payload_expansion",
        target: allowedEntry.target,
        start_offset: 900,
        byte_budget: 512
      }
    });
    const continuedKey = Object.keys(continuedRes.previews)[0]!;
    expect(continuedRes.previews[continuedKey]).toBe(m3.slice(0, 512));

    const rejectedRes = await readersPort.recall(makeWorkerRequest("obsidian primary prompt"));
    expect(rejectedRes.index.entries).toHaveLength(1);
    const rejectedEntry = rejectedRes.index.entries[0]!;
    expect(rejectedEntry.target).toMatchObject({
      root_id: rejected.rootId,
      span: { content_start: 0, content_end: 400, content_complete: false }
    });
    const rejectedPreviewKey = Object.keys(rejectedRes.previews)[0]!;
    expect(rejectedRes.previews[rejectedPreviewKey]).toBe(r1);
    await readersPort.acknowledge!(rejectedRes.preparation_id!, rejectedRes.index, new Map(Object.entries(rejectedRes.previews)));
  }, 30_000);
});
