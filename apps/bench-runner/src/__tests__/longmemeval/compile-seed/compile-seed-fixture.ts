import { createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import { createInMemoryFieldStores } from "../../../../../../packages/core/src/memory/evidence-create/field-stores.js";
import type {
  BenchSignalSeedInput,
  SeededMemoryResult
} from "../../../harness/daemon.js";
import type { SeededObjectResult } from
  "../../../harness/daemon/seed/daemon-seed-types.js";
import {
  createCachingSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig
} from "../../../runs/compile-seed.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SOURCE_STATEMENTS_PROMPT, OFFICIAL_API_SYSTEM_PROMPT, buildOfficialApiSourceCorpus,
  collectOfficialApiExtractionCoverage, stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { fixtureAttemptAuthority, providerBackedResponseResult } from
  "../extraction/extraction-cache-test-fixture.js";
import type { ConversationMessage, SourceStatementRequest } from "@do-soul/alaya-protocol";
import { sourceStatementRequests, sourceStatementSession } from "../../../runs/extraction/source-statement-request.js";

/** Source imports use the admission owner; the callback observes only emitted signal inputs. */
export function buildCompileSeedDaemon(
  onSignal: (input: BenchSignalSeedInput) => SeededMemoryResult
): CompileSeedDaemon {
  return {
    importSourceRecord: createCompileSeedSourceImporter(),
    proposeMemoryFromSignal: async (input) => onSignal(input),
    proposeMemoriesFromCompileSignals: async (inputs) => {
      const seeds = inputs.map(onSignal);
      return {
        seeds,
        dropped: [],
        createdEvidence: seeds.some(seedCreatedEvidence)
      };
    },
    proposeSynthesis: async () => ({ synthesisId: null })
  };
}

export function createCompileSeedSourceImporter(workspaceId = "workspace-1"): CompileSeedDaemon["importSourceRecord"] {
  const admission = createSourceAdmissionPort({ stores: createInMemoryFieldStores(), sha256: fieldContractSha256 });
  return async (input, hostCapture) => admission.admit({ ...input, workspace_id: workspaceId, evidence_object_id: null },
    { workspaceId, ...(hostCapture === undefined ? {} : { hostCapture }) });
}

function seedCreatedEvidence(seed: SeededObjectResult): boolean {
  return seed.kind === "evidence_capsule" || seed.evidenceId !== null;
}

export const CREDENTIALLED_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

export const OFFLINE_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: null
};

/** Prewarm current session requests with recorded transport output and its attempt ledger. */
export async function admitStatementSessionCache(input: { cacheRoot: string; messages: readonly ConversationMessage[];
  config?: CompileSeedExtractionConfig; rawJson: (request: SourceStatementRequest) => string }): Promise<void> {
  const config = input.config ?? CREDENTIALLED_CONFIG, requests = sourceStatementRequests(input.messages);
  const manifestPath = join(input.cacheRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest,
    requested_turns: requests.length, cached_turns: requests.length, coverage: 1 }));
  const authority = fixtureAttemptAuthority({ cacheRoot: input.cacheRoot, model: config.model,
    requestProfile: config.requestProfile, startingMissing: Math.max(1, requests.length) });
  const extractor = createCachingSignalExtractor({ cacheRoot: input.cacheRoot, config, ...authority,
    delegate: { extract: attempt => providerBackedResponseResult(attempt, input.rawJson(JSON.parse(attempt.userPrompt))) } });
  const sourceCorpus = sourceStatementSession(input.messages).rendered.content;
  for (const request of requests) await extractor.extract({ systemPrompt: SOURCE_STATEMENTS_PROMPT,
    userPrompt: request.userPrompt, sourceCorpus });
}

/** Retained assertion-cache fixture, not current session extraction. */
export async function admitCompileSeedTurnCache(input: {
  readonly cacheRoot: string;
  readonly turnContent: string;
  readonly turnMessages?: Parameters<typeof collectOfficialApiExtractionCoverage>[1];
  readonly config?: CompileSeedExtractionConfig;
  readonly rawJson: string | ((request: ReturnType<typeof collectOfficialApiExtractionCoverage>["requests"][number],
    index: number) => string);
}): Promise<void> {
  const config = input.config ?? CREDENTIALLED_CONFIG;
  const messages = input.turnMessages ?? [];
  const coverage = collectOfficialApiExtractionCoverage(
    input.turnContent, messages, config.sourcePacking);
  const manifestPath = join(input.cacheRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest,
    requested_turns: coverage.requests.length,
    cached_turns: coverage.requests.length, coverage: 1 }));
  const authority = fixtureAttemptAuthority({ cacheRoot: input.cacheRoot,
    model: config.model, requestProfile: config.requestProfile,
    startingMissing: Math.max(1, coverage.requests.length) });
  const sourceCorpus = buildOfficialApiSourceCorpus(input.turnContent, messages);
  for (const [index, request] of coverage.requests.entries()) {
    const rawJson = typeof input.rawJson === "string" ? input.rawJson : input.rawJson(request, index);
    const extractor = createCachingSignalExtractor({ cacheRoot: input.cacheRoot, config,
      ...authority, delegate: { extract: (attempt) => providerBackedResponseResult(attempt, rawJson) } });
    await extractor.extract({ systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(request), sourceCorpus });
  }
}

export function interpretationsEnvelope(
  facts: readonly { matched: string; assertionId?: number }[]
): string {
  return JSON.stringify({
    interpretations: facts.map((fact) => ({
      assertion_id: fact.assertionId ?? 1,
      relations: [{
        predicate: { text: fact.matched.split(/\s+/u).find((token) => /[A-Za-z]{3,}/u.test(token)) ?? fact.matched },
        arguments: [],
        qualifiers: []
      }]
    }))
  });
}

export function signalsEnvelope(
  facts: readonly { distilled: string; matched: string; assertionId?: number }[]
): string {
  return JSON.stringify({
    signals: facts.map((fact) => withOpenSemanticFactorGraph({
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: fact.matched,
      distilled_fact: fact.distilled,
      source_locator: {
        contract_version: 4,
        kind: "assertion_catalog",
        assertion_id: fact.assertionId ?? 1
      }
    }))
  });
}

export { providerBackedExtractionResult as providerBackedResult } from
  "../extraction/extraction-cache-test-fixture.js";

export function withOpenSemanticFactorGraph<T extends Readonly<{
  readonly matched_text: string;
}>>(signal: T): T & Readonly<{ semantic_factor_graph: Readonly<Record<string, unknown>> }> {
  const surface = signal.matched_text.slice(0, 64);
  return {
    ...signal,
    semantic_factor_graph: {
      schema_version: 2,
      source_kind: "evidence",
      factors: [{
        factor_id: "fact",
        semantic_identity: surface.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
        surface,
        source_occurrence: 0
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "fact-proposition",
        predicate_factor_id: "fact",
        arguments: [{
          position: 0,
          binding_identity: "fact",
          reference_kind: "factor",
          reference_id: "fact"
        }]
      }]
    }
  };
}

export function makeSeed(memoryId: string): SeededMemoryResult {
  return {
    memoryId,
    signalId: `signal-${memoryId}`,
    proposalId: `proposal-${memoryId}`,
    evidenceId: `evidence-${memoryId}`,
    truncated: false,
    charsClipped: 0
  };
}
