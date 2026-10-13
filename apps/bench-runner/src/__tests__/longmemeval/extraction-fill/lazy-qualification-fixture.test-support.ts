import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { vi } from "vitest";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { preflightExtractionBatch } from "../../../runs/extraction/fill/batch-preflight.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { publishSourceSemanticSnapshot, type SourcePublicationReport } from "../../../runs/snapshot/source-records/publish.js";
import { parseSemanticProposalWorkset, semanticProposalWorksetContract } from "../../../runs/semantic-proposal/workset.js";
import { readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import type { SemanticChainConfig } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitNativeLazyConfig } from "../../../runs/semantic-chain/bind-lazy.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";

export const MODEL = "gemini-2.5-flash-lite";
export const PROFILE = "gemini-2.5-nonthinking-v1" as const;

export function question(contents: readonly string[]) {
  return { question_id: "bounded", question_type: "fixture", question: "What was completed?", answer: "unused",
    question_date: "2026-09-23", haystack_session_ids: contents.map((_, index) => `session-${index}`),
    haystack_dates: contents.map(() => "2023-09-10"),
    haystack_sessions: contents.map(content => [{ role: "user" as const, content }]), answer_session_ids: [] };
}

/** Only quiescent raw source bytes are shared; all authority and runtime paths belong to each test. */
export function createLazyQualificationFixtures(
  readRoots: () => { cacheRoot: string; dataDir: string; pinnedMetaRoot: string },
  writeDataset: (questions: readonly LongMemEvalQuestion[]) => Promise<void>
) {
  const sealed = new Map<string, { bytes: Buffer; report: SourcePublicationReport }>();

  async function rawSourceSnapshot(contents: readonly string[]): Promise<SourcePublicationReport> {
    const { cacheRoot, dataDir, pinnedMetaRoot } = readRoots();
    const key = JSON.stringify(contents);
    const snapshotPath = join(cacheRoot, "starting.sqlite");
    const retained = sealed.get(key);
    if (retained !== undefined) {
      // A byte copy keeps the seed private even when a test damages its own SQLite file.
      writeFileSync(snapshotPath, retained.bytes, { flag: "wx" });
      if (hashRegularFileNoFollow(snapshotPath) !== retained.report.db_sha256) {
        throw new Error("raw source fixture copy differs from its sealed publication");
      }
      const report = { ...structuredClone(retained.report), snapshot_path: snapshotPath };
      writeFileSync(`${snapshotPath}.publication.json`, JSON.stringify(report), { flag: "wx" });
      return report;
    }
    const published = await publishSourceSemanticSnapshot({ snapshotPath,
      dataDirRoot: join(cacheRoot, "starting-runtime"), recordedAt: "2026-09-23T00:00:00.000Z",
      producerCommit: "a".repeat(40), workspaceId: "bounded-workspace", runId: "bounded-run",
      populations: [{ name: "fixture", dataDir, pinnedMetaRoot, questionWindow: { offset: 0, limit: 1 },
        model: MODEL, requestProfile: PROFILE }] });
    const bytes = readFileSync(published.snapshot_path);
    if (hashRegularFileNoFollow(published.snapshot_path) !== published.db_sha256) {
      throw new Error("raw source fixture changed after publication");
    }
    sealed.set(key, { bytes, report: structuredClone(published) });
    return published;
  }

  async function sourceFixture(contents: readonly string[], outputByteLimit = 100000,
    sourceCacheRoot = readRoots().cacheRoot) {
    const { cacheRoot, dataDir, pinnedMetaRoot } = readRoots();
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
    await writeDataset([question(contents)]);
    mkdirSync(sourceCacheRoot, { recursive: true });
    const preflight = await preflightExtractionBatch({ variant: "longmemeval_s", cacheRoot: sourceCacheRoot, dataDir, pinnedMetaRoot,
      offset: 0, limit: 1, sourcePacking: "complete-source", openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
      batch: { operation: "prepare", limits: { maxJobs: 1, maxRequestsPerJob: 64,
        maxFileBytes: 1000000, maxInputTokensPerJob: 1000000, maxEnqueuedTokens: 1000000,
        maxOutputTokens: 4096, maxUsd: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
        deadlineMs: 60000, requestTimeoutMs: 5000, maxPolls: 10 } } });
    const preflightPath = join(cacheRoot, "source-preflight.json");
    writeFileSync(preflightPath, JSON.stringify(preflight));
    const published = await rawSourceSnapshot(contents);
    const workset = parseSemanticProposalWorkset({ contract: semanticProposalWorksetContract(PROFILE),
      provider_url: "https://fixture-provider.invalid", kind: "query", model: MODEL, request_profile: PROFILE,
      items: [{ original_query: "What was completed?" }] });
    const chain: SemanticChainConfig = { snapshot_path: published.snapshot_path, snapshot_sha256: published.db_sha256,
      implementation_revision: readCurrentExtractionAuthorityRevision(), interpretation_clock: "2026-09-23T00:00:00.000Z",
      workspace_id: "bounded-workspace", run_id: "bounded-run", query_workset: workset,
      query_cache_root: join(cacheRoot, "query-cache"), correspondence_cache_root: join(cacheRoot, "correspondence-cache"),
      max_output_tokens: 4096, discovery_page_cap: 4, correspondence_pair_cap: 2,
      access_policy: "query-conditioned-v1", budget: { schema_version: 1, work_units: 1000000,
        memory_bytes: 60000000, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: outputByteLimit };
    const bind = async (currentChain = chain, label = "initial") => {
      const initialChainRoot = join(cacheRoot, `initial-${label}`);
      const plan = await prepareSemanticChain(currentChain, initialChainRoot);
      const bound = await admitNativeLazyConfig({ plan, initialChainRoot,
        population: { name: "fixture", dataDir, pinnedMetaRoot, questionWindow: { offset: 0, limit: 1 } },
        sourcePreflightPath: preflightPath, sourceCacheRoot,
        recordedAt: "2026-09-23T00:00:00.000Z", producerCommit: "a".repeat(40) });
      return bound.config;
    };
    return { chain, published, bind };
  }

  async function preparedSourceFixture(contents: readonly string[], outputByteLimit = 100000,
    sourceCacheRoot = readRoots().cacheRoot) {
    const fixture = await sourceFixture(contents, outputByteLimit, sourceCacheRoot);
    return { ...fixture, config: await fixture.bind() };
  }

  return { sourceFixture, preparedSourceFixture };
}
