import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT } from "@do-soul/alaya-protocol";
import { deriveAddressableSpanViews, SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION } from "@do-soul/alaya-core";
import { parseSourceSemanticRequest, type SourceSemanticCorrespondenceProposalInput } from "@do-soul/alaya-soul";
import { interpretedQueryRaw } from "../query-producer-fixture.js";
import { correspondenceAssessmentJson } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-producer-fixture.js";
import { syntheticGeminiBody } from "../../runs/semantic-proposal/gemini-response-evidence.test-support.js";
import { admitRetainedNativeSourceSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { checkpointAndCopyBenchDb } from "../../../runs/snapshot/freeze/db-copy.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../../runs/snapshot/materialize.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import type { ExtractionRequestProfile } from "../../../runs/extraction/request-profile.js";

export const CLOCK = "2026-09-25T00:00:00.000Z";
export const OBSERVED = "2026-09-20T12:00:00.000Z";
export const INGESTED = ["2026-09-21T09:00:00.000Z", "2026-09-21T09:00:01.000Z"] as const;
export const URL = "https://generativelanguage.googleapis.com";
export const MODEL = "gemini-3.1-flash-lite";
export const H_PROFILE = "gemini-3.1-low-v1";
export const Q_PROFILE = "gemini-3.1-minimal-v1";
export const BUDGET = { schema_version: 1, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
export const ALLOWANCE = { total_work_units: 4_000_000_000, total_memory_bytes: 30_000_000_000,
  read_work_units: 10_000_000, read_memory_bytes: 100_000_000,
  max_input_bytes_per_read: 100_000_000, max_read_admissions: 256, max_effects: 32 };
export function queryRaw(date: boolean, reviewed: boolean): string {
  const roles = date ? [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "tool", target: { kind: "free", key: "answer", return: true }, excerpt: "Which tool" },
    { role: "purpose", target: { kind: "named", key: "purpose", excerpt: "indexing" }, excerpt: "indexing" },
    ...(reviewed ? [{ role: "event_date", target: { kind: "named", key: "eventDate",
      excerpt: "August 14, 2026" }, excerpt: "August 14, 2026" }] : [])
  ] : [
    { role: "actor", target: { kind: "named", key: "actor", excerpt: "Mira" }, excerpt: "Mira" },
    { role: "format", target: { kind: "free", key: "answer", return: true }, excerpt: "Which file format" },
    { role: "export", target: { kind: "named", key: "export", excerpt: "Atlas export" }, excerpt: "Atlas export" }
  ];
  return interpretedQueryRaw({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", key: "use", predicate: "use", arguments: roles }] }], gaps: [] });
}

export function sourceRaw(prompt: string, completeInitial = false): string {
  const request = parseSourceSemanticRequest(JSON.parse(prompt));
  const assertions = request.source_request.source_assertions;
  const revision = request.source_request.revision !== undefined;
  const selected = revision || completeInitial ? assertions.find(row => row.text.includes(" used ")) ?? assertions.find(row => row.text.includes(" archived ")) ?? assertions[0]
    : assertions[0];
  if (selected === undefined) throw new Error("source response has no assertion");
  const text = selected.text;
  const indexing = /Mira used (\w+) for indexing on (\d{4}-\d{2}-\d{2})\./u.exec(text);
  const format = /Mira used (\w+) for the (\w+) export\./u.exec(text);
  const named = indexing ? { actor: "Mira", tool: indexing[1]!, purpose: "indexing", event_date: indexing[2]! }
    : format ? { actor: "Mira", format: format[1]!, export: format[2]! }
      : { export: "Atlas" };
  const quote = (value: string) => ({ assertion_id: selected.assertion_id, text: value });
  const entities = Object.entries(named).map(([key, value]) => ({ form: "selection", key,
    selection: quote(value) }));
  const use = indexing !== null || format !== null;
  const predicate = use ? "used" : text.includes("archived") ? "archived" : "completed";
  return JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
    content: { roots: [{ act: "assertion", expression: { kind: "content_ref", key: "event" } }],
      entities, nodes: [{ kind: "statement", key: "event", predicate: { kind: "explicit",
        reading: use ? "use" : predicate, support: quote(predicate) },
        arguments: Object.keys(named).map(role => ({ role, target: { kind: "entity_ref", key: role } })),
        qualifications: [] }], gaps: [] } });
}

export function correspondenceRaw(prompt: string): string {
  const request = JSON.parse(prompt) as SourceSemanticCorrespondenceProposalInput;
  const interpretation = request.source_interpretation_descriptors[0]!.interpretation;
  const query = request.admitted_query_semantics;
  const frame = interpretation.frames[0]!;
  const queryFrame = query.alternatives[0]!.frames[0]!;
  const pairs: object[] = [];
  if (frame.predicate_support.kind === "explicit" && frame.predicate_support.reading === "use") pairs.push({
    relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
    source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "use" },
    source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] });
  for (const requirement of queryFrame.role_requirements) {
    const slot = frame.slots.find(row => row.role_reading === requirement.role_reading);
    if (slot === undefined) continue;
    const target = frame.bindings.find(row => row.slot_id === slot.id)?.target;
    if (target?.kind !== "node") throw new Error("authored source role lacks referent");
    const referent = interpretation.referents.find(row => row.id === target.id)!;
    const support = [{ kind: "lexical", mentions: [referent.mentions[0]!] }];
    pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: requirement.id },
      source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id },
      query_support: requirement.support, source_semantic_support: support });
    const variable = query.variables.find(row => row.id === requirement.target_variable);
    const sourceText = referent.mentions.map(id => interpretation.mentions.find(row => row.id === id)?.text ?? "").join(" ");
    const reference = variable?.reference?.excerpt ?? "";
    const same = requirement.role_reading === "event_date"
      ? new Date(`${sourceText}T00:00:00.000Z`).getTime() === new Date(`${reference} UTC`).getTime()
      : reference.includes(sourceText);
    if (variable?.reference !== undefined && same) pairs.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "referent", variable: variable.id },
      source_endpoint: { kind: "referent", referent: referent.id },
      query_support: variable.reference, source_semantic_support: support });
  }
  return correspondenceAssessmentJson({ ...request,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID,
    producer_version: SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_VERSION },
  { correspondences: pairs });
}

export async function fillProposal(path: string, cacheRoot: string, raw: (prompt: string) => string,
  profile: ExtractionRequestProfile, onAttempt?: () => void) {
  const workset = parseSemanticProposalWorkset(JSON.parse(readFileSync(path, "utf8")));
  mkdirSync(cacheRoot, { recursive: true });
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 16_384, 1),
    inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 });
  return executeSemanticProposalFill({ workset, cacheRoot, authority,
    config: { providerUrl: URL, model: MODEL, requestProfile: profile, apiKey: "fixture" },
    extractor: { extract: async ({ userPrompt }) => {
      onAttempt?.();
      const rawJson = raw(userPrompt);
      return { rawJson, responseMetadata: { finishReason: "STOP" },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        responseBody: syntheticGeminiBody(rawJson, "STOP", { inputTokens: 10, outputTokens: 20, totalTokens: 30 }) };
    } } });
}

export async function fillSource(root: string, snapshotPath: string, cacheRoot: string,
  generation: typeof EXTRACTION_OPEN_SEMANTICS_GENERATION, keys: readonly string[], label: string,
  raw: (prompt: string) => string = sourceRaw, onAttempt?: () => void) {
  mkdirSync(cacheRoot, { recursive: true });
  const options = { variant: "native_source_snapshot" as const,
    nativeSourcePopulation: { name: "originals", snapshotPath }, cacheRoot,
    sourcePacking: "complete-source" as const, openSemantics: generation };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample",
    revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: keys,
    preflightOutputTokenCap: 16_384, geminiQuoteRates: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 } });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(keys, inspection), sourcePreflight: preflight,
    observation: inspection.observation, inspection, maxConcurrency: 1,
    outputTokenCap: { field: "maxOutputTokens", value: 16_384 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(root, `${label}-receipt.json`), preflightPath = join(root, `${label}-preflight.json`);
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  writeFileSync(preflightPath, JSON.stringify(preflight));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    onAttempt?.();
    const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const response = raw(prompt);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } });
  }));
  const filled = await runExtractionFill({ ...options, authorityReceiptPath: receiptPath, concurrency: 1 });
  expect(filled.newlyExtracted).toBe(keys.length);
  return preflightPath;
}

type RetainedRecoverySource = Pick<Parameters<Awaited<ReturnType<typeof startBenchDaemon>>["importSourceRecord"]>[0],
  "source_id" | "content_bytes" | "speaker" | "event_time" | "attribution_context"> & { recorded_at?: string };

export async function prepareRetainedRecoverySnapshot(root: string, snapshotPath: string, workspaceId: string,
  sources: readonly RetainedRecoverySource[]) {
  const dataDirRoot = join(root, "retained-daemon"), retainedPath = join(root, "retained.sqlite");
  const daemon = await startBenchDaemon({ dataDirRoot, workspaceId, runId: "source-capture",
    embeddingMode: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
  try {
    for (const [index, source] of sources.entries()) await daemon.importSourceRecord({ ...source,
      source_version: "1", recorded_at: source.recorded_at ?? new Date(Date.parse(INGESTED[0]) + index * 1000).toISOString(),
      valid_from: null, valid_to: null, scope_class: "project", spans: deriveAddressableSpanViews(source.content_bytes) });
    await daemon.checkpointFieldProjection();
  } finally { await daemon.shutdown(); }
  checkpointAndCopyBenchDb(join(dataDirRoot, BENCH_DAEMON_DB_FILENAME), retainedPath);
  await admitRetainedNativeSourceSnapshot({ retainedPath, expectedSha256: hashRegularFileNoFollow(retainedPath),
    snapshotPath, workspaceId, runId: workspaceId, producerCommit: "0".repeat(40) });
}

export function readRetainedSourceMetadata(snapshotPath: string) {
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try { return database.prepare("SELECT source_id, event_time, speaker, recorded_at FROM source_records ORDER BY source_id").all(); }
  finally { database.close(); }
}
