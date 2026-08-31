import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION
} from "../../triage/grounding/source-locator.js";

export const OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION = 2;
export const OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION = 1;
export const OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH = 8;

const OfficialApiSourceAssertionSchema = z.object({
  assertion_id: z.number().int().positive(),
  text: z.string().trim().min(1)
}).strict().readonly();

const OfficialApiExtractionRequestSchema = z.object({
  schema_version: z.literal(OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION),
  source_locator_contract_version: z.literal(OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION),
  batch_contract_version: z.literal(OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION),
  source_corpus_identity: z.string().regex(/^[a-f0-9]{64}$/u),
  batch_index: z.number().int().nonnegative(),
  batch_count: z.number().int().positive(),
  source_assertions: z.array(OfficialApiSourceAssertionSchema)
    .max(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH)
    .readonly()
}).strict().refine(
  ({ batch_index, batch_count }) => batch_index < batch_count,
  { message: "batch_index must be less than batch_count" }
).readonly();

export type OfficialApiExtractionRequest = z.infer<typeof OfficialApiExtractionRequestSchema>;

export function buildOfficialApiExtractionRequest(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[]
): OfficialApiExtractionRequest {
  const requests = buildOfficialApiExtractionRequests(turnContent, messages);
  if (requests.length !== 1) {
    throw new TypeError("official API extraction requires a batched request plan");
  }
  return requests[0]!;
}

export function buildOfficialApiExtractionRequests(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[]
): readonly OfficialApiExtractionRequest[] {
  const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, messages);
  const assertions = buildOfficialApiSourceAssertions(sourceCorpus);
  const sourceCorpusIdentity = computeOfficialApiSourceCorpusIdentity(sourceCorpus);
  const batchCount = Math.max(
    1,
    Math.ceil(assertions.length / OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH)
  );
  if (assertions.length === 0) {
    return Object.freeze([buildRequest([], sourceCorpusIdentity, 0, batchCount)]);
  }
  const requests: OfficialApiExtractionRequest[] = [];
  for (let offset = 0; offset < assertions.length;
    offset += OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH) {
    requests.push(buildRequest(assertions.slice(
      offset,
      offset + OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH
    ), sourceCorpusIdentity, requests.length, batchCount));
  }
  return Object.freeze(requests);
}

function buildRequest(
  sourceAssertions: ReturnType<typeof buildOfficialApiSourceAssertions>,
  sourceCorpusIdentity: string,
  batchIndex: number,
  batchCount: number
): OfficialApiExtractionRequest {
  return OfficialApiExtractionRequestSchema.parse({
    schema_version: OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
    source_locator_contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
    batch_contract_version: OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
    source_corpus_identity: sourceCorpusIdentity,
    batch_index: batchIndex,
    batch_count: batchCount,
    source_assertions: sourceAssertions
  });
}

export function computeOfficialApiSourceCorpusIdentity(sourceCorpus: string): string {
  return createHash("sha256").update(JSON.stringify({
    contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
    source_corpus: sourceCorpus
  }), "utf8").digest("hex");
}

export function parseOfficialApiExtractionRequest(value: unknown): OfficialApiExtractionRequest {
  const parsed = OfficialApiExtractionRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("invalid official API extraction request", { cause: parsed.error });
  }
  return parsed.data;
}

export function stringifyOfficialApiExtractionRequest(
  request: OfficialApiExtractionRequest
): string {
  return JSON.stringify(parseOfficialApiExtractionRequest(request));
}

export function officialApiExtractionRequestTemplatePreimage(): string {
  const sentinel = "I recorded the source-bound semantic factor request template.";
  const request = buildOfficialApiExtractionRequest(
    sentinel,
    [{ role: "user", content: sentinel }]
  );
  return JSON.stringify({
    serialized_request: stringifyOfficialApiExtractionRequest(request),
    assertions_per_batch: OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
    batch_contract_version: OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION
  });
}
