import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import {
  proposeAlignmentSemantics, proposeQuerySemantics, type SourceSemanticAlignmentRequest
} from "@do-soul/alaya-soul";
import { createGeminiHttpExtractor } from "../compile-seed/http/gemini-http.js";
import { GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "../compile-seed/http/gemini-http.js";
import { resolveExtractionRequestTimeoutMs } from "../compile-seed/http/output-token-retry.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import {
  SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY, type SemanticProposalLine, type SemanticProposalWorkset,
  materializeSemanticProposalLines
} from "./workset.js";
import { type SemanticProposalAuthority, buildSemanticProposalPreflight } from "./authority.js";
import {
  listSemanticProposalKeys, readSemanticProposalShard, writeSemanticProposalShard,
  SEMANTIC_PROPOSAL_CACHE_CONTRACT
} from "./artifact.js";

export type ProposalAttemptClass = "admitted" | "retryable" | "terminal";

export function classifyProposalOutcome(outcome: Readonly<{ status: string; reason?: string }>): ProposalAttemptClass {
  if (outcome.status === "interpreted" || outcome.status === "abstained") return "admitted";
  if (outcome.status === "transport_failure") return "retryable";
  if (outcome.status === "invalid" && outcome.reason === "malformed_json") return "retryable";
  return "terminal";
}

export function prepareSemanticProposal(
  workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens);
  return buildSemanticProposalPreflight({
    kind: workset.kind, model: workset.model, request_profile: workset.request_profile,
    maxOutputTokens, lines, cachedKeys: listSemanticProposalKeys(cacheRoot, workset.kind)
  });
}

export async function executeSemanticProposalFill(input: Readonly<{
  workset: SemanticProposalWorkset;
  cacheRoot: string;
  authority: SemanticProposalAuthority;
  config: CompileSeedExtractionConfig;
}>): Promise<Readonly<{
  requested: number; cache_hits: number; newly_admitted: number; terminal_failures: number; attempts: number;
}>> {
  refuseRecallCampaignLiveExtraction("extraction_write");
  if (input.config.apiKey === null || input.config.apiKey.trim().length === 0) {
    throw new Error("garden API key is unavailable");
  }
  if (input.authority.kind !== input.workset.kind || input.authority.model !== input.workset.model ||
      input.authority.request_profile !== input.workset.request_profile) {
    throw new Error("semantic proposal authority does not bind this workset");
  }
  mkdirSync(input.cacheRoot, { recursive: true });
  const maxOutputTokens = input.authority.limits.max_output_tokens;
  const lines = materializeSemanticProposalLines(input.workset, maxOutputTokens);
  const authorized = new Set(input.authority.keys);
  const extractor = createGeminiHttpExtractor(input.config);
  let newlyAdmitted = 0, terminalFailures = 0, attempts = 0, cacheHits = 0;
  for (const line of lines) {
    if (readSemanticProposalShard(input.cacheRoot, line.key) !== undefined) {
      cacheHits += 1;
      continue;
    }
    if (!authorized.has(line.key)) continue;
    assertAttemptInputWithinReceiptLimit(line.inputByteUpper, input.authority.price.maximum_input_tokens_per_attempt);
    const filled = await fillLine(input, line, extractor, maxOutputTokens);
    attempts += filled.attempts;
    if (filled.admitted) newlyAdmitted += 1;
    else terminalFailures += 1;
  }
  return { requested: lines.length, cache_hits: cacheHits, newly_admitted: newlyAdmitted,
    terminal_failures: terminalFailures, attempts };
}

async function fillLine(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  extractor: ReturnType<typeof createGeminiHttpExtractor>,
  maxOutputTokens: number
): Promise<{ admitted: boolean; attempts: number }> {
  let lastRaw = "";
  let lastUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  for (let attempt = 1; attempt <= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY; attempt += 1) {
    try {
      const extracted = await extractor.extract({
        systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
        timeoutMs: Math.max(resolveExtractionRequestTimeoutMs(maxOutputTokens), GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS),
        maxOutputTokens, outputTokenField: "maxOutputTokens",
        validateRawJson: () => undefined, responseJsonSchema: line.responseJsonSchema
      });
      lastRaw = extracted.rawJson;
      lastUsage = extracted.usage;
      const outcome = receiveLine(line, extracted.rawJson).outcome;
      const classified = classifyProposalOutcome(outcome);
      if (classified === "retryable" && attempt < SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY) continue;
      writeAttempt(input, line, lastRaw, lastUsage, outcome, classified === "admitted", attempt);
      return { admitted: classified === "admitted", attempts: attempt };
    } catch (cause) {
      appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
        `${line.key}\t${cause instanceof Error ? cause.message : String(cause)}\n`);
      lastRaw = "";
      lastUsage = undefined;
      if (attempt === SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY) {
        writeAttempt(input, line, lastRaw, lastUsage, { status: "transport_failure" }, false, attempt);
        return { admitted: false, attempts: attempt };
      }
    }
  }
  return { admitted: false, attempts: SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY };
}

function receiveLine(line: SemanticProposalLine, rawJson: string) {
  const producer = line.request.producer_capability;
  if (line.kind === "query") {
    return proposeQuerySemantics({
      original_query: line.original_query, producer_id: producer.producer_id, producer_version: producer.producer_version
    }, { rawJson });
  }
  const request = line.request as SourceSemanticAlignmentRequest;
  return proposeAlignmentSemantics({
    admitted_q: request.admitted_q, h_descriptors: request.h_descriptors,
    producer_id: producer.producer_id, producer_version: producer.producer_version
  }, { rawJson });
}

function writeAttempt(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  rawJson: string,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined,
  outcome: unknown,
  admitted: boolean,
  attemptOrdinal: number
): void {
  writeSemanticProposalShard(input.cacheRoot, {
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: line.kind, cache_key: line.key,
    model: input.workset.model, request_profile: input.workset.request_profile,
    original_query: line.original_query, system_prompt: line.systemPrompt, user_prompt: line.userPrompt,
    raw_json: rawJson, outcome, admitted, attempt_ordinal: attemptOrdinal,
    extracted_at: new Date().toISOString(),
    ...(usage === undefined ? {} : { usage })
  });
}
