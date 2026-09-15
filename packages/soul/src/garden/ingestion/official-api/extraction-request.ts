import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_EXTRACTION_SOURCE_PACKING, extractionSourcePackingSize,
  SourceAssertionIdSchema,
  type ExtractionSourcePacking, type ConversationMessage
} from "@do-soul/alaya-protocol";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus,
  indexOfficialApiSourceAssertions,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION
} from "../../triage/grounding/source-locator.js";
import {
  indexSourceAssertions,
  pageSourceAssertionInventory,
  type SourceAssertionCatalogCursor,
  type SourceAssertionCatalogPage
} from "../../triage/grounding/source-locator/assertion-catalog.js";
import { collectSourceRoleMarkers } from
  "../../triage/grounding/source-role/marker.js";
import { planTurnTransportPacks } from "./transport-pack.js";
import {
  ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID,
  bindAssertionSource,
  computeAssertionOccurrenceIdentity,
  computeAssertionSemanticKey,
  createAssertionSemanticIdentityWitness,
  digestSourceText,
  resolveAssertionSemanticContext,
  type AssertionSemanticIdentityWitness,
  type AssertionSourceBinding
} from "../../triage/grounding/source-locator/assertion-semantic-identity.js";

export const OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION = 2;
export const OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION = 1;
export const OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH = 8;

const OfficialApiSourceAssertionSchema = z.object({
  assertion_id: SourceAssertionIdSchema,
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

export type { SourceAssertionCatalogCursor, SourceAssertionCatalogPage };

export interface OfficialApiExtractionWindowPlan {
  readonly catalog: SourceAssertionCatalogPage;
  readonly requests: readonly OfficialApiExtractionRequest[];
}

export function buildOfficialApiExtractionRequest(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  sourcePacking: ExtractionSourcePacking = DEFAULT_EXTRACTION_SOURCE_PACKING
): OfficialApiExtractionRequest {
  const requests = buildOfficialApiExtractionRequests(turnContent, messages, sourcePacking);
  if (requests.length !== 1) {
    throw new TypeError("official API extraction requires a batched request plan");
  }
  return requests[0]!;
}

export function buildOfficialApiExtractionRequests(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  sourcePacking: ExtractionSourcePacking = DEFAULT_EXTRACTION_SOURCE_PACKING,
  catalogCursor?: SourceAssertionCatalogCursor | null
): readonly OfficialApiExtractionRequest[] {
  return planOfficialApiExtractionWindow(
    turnContent, messages, sourcePacking, catalogCursor
  ).requests;
}

export interface OfficialApiExtractionCoverage {
  readonly catalog: SourceAssertionCatalogPage;
  readonly requests: readonly OfficialApiExtractionRequest[];
}

/** Follows catalog cursors until source_range_complete. One-window callers use the planner. */
export function collectOfficialApiExtractionCoverage(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  sourcePacking: ExtractionSourcePacking = DEFAULT_EXTRACTION_SOURCE_PACKING
): OfficialApiExtractionCoverage {
  const windows: OfficialApiExtractionWindowPlan[] = [];
  let cursor: SourceAssertionCatalogCursor | null | undefined;
  let previousCursorId: number | undefined;
  do {
    if (cursor != null) {
      if (cursor.after_assertion_id === previousCursorId) {
        throw new TypeError("catalog cursor did not advance");
      }
      previousCursorId = cursor.after_assertion_id;
    }
    const window = planOfficialApiExtractionWindow(
      turnContent, messages, sourcePacking, cursor
    );
    windows.push(window);
    cursor = window.catalog.next_cursor;
  } while (cursor !== null);

  const last = windows[windows.length - 1]!;
  return Object.freeze({
    catalog: Object.freeze({
      ...last.catalog,
      window: Object.freeze(windows.flatMap((item) => item.catalog.window))
    }),
    requests: Object.freeze(windows.flatMap((item) =>
      item.catalog.window.length > 0 || windows.length === 1 ? [...item.requests] : []
    ))
  });
}

export function planOfficialApiExtractionWindow(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  sourcePacking: ExtractionSourcePacking = DEFAULT_EXTRACTION_SOURCE_PACKING,
  catalogCursor?: SourceAssertionCatalogCursor | null
): OfficialApiExtractionWindowPlan {
  const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, messages);
  const catalog = pageSourceAssertionInventory(
    indexOfficialApiSourceAssertions(sourceCorpus),
    catalogCursor
  );
  const assertions = Object.freeze(catalog.window.map(({ assertion_id, text }) =>
    Object.freeze({ assertion_id, text })
  ));
  const sourceCorpusIdentity = computeOfficialApiSourceCorpusIdentity(sourceCorpus);
  const byId = new Map(assertions.map((assertion) => [assertion.assertion_id, assertion]));
  const pageIds = new Set(byId.keys());
  const workset = mintOfficialApiAssertionBindings(turnContent, messages)
    .filter((binding) => pageIds.has(binding.locator.assertion_id));
  const plan = planTurnTransportPacks(
    workset.map((binding) => {
      const assertion = byId.get(binding.locator.assertion_id);
      if (assertion === undefined) {
        throw new TypeError("legacy request wrapper lost a catalog assertion");
      }
      return {
        semanticKey: binding.semanticKey,
        assertionId: binding.locator.assertion_id,
        text: assertion.text
      };
    }),
    { kind: "reference_batch", assertionsPerPack: extractionSourcePackingSize(sourcePacking) }
  );
  const packs = plan.packs.filter((pack) => pack.assertion_ids.length > 0);
  const requests = packs.length === 0
    ? Object.freeze([buildRequest([], sourceCorpusIdentity, 0, 1)])
    : Object.freeze(packs.map((pack, batchIndex) => buildRequest(
      pack.assertion_ids.map((assertionId) => {
        const assertion = byId.get(assertionId);
        if (assertion === undefined) {
          throw new TypeError("transport pack referenced a missing assertion");
        }
        return assertion;
      }),
      sourceCorpusIdentity,
      batchIndex,
      packs.length
    )));
  return Object.freeze({ catalog, requests });
}

export interface MintedOfficialApiAssertionBinding {
  readonly binding: AssertionSourceBinding;
  readonly semanticIdentity: AssertionSemanticIdentityWitness;
}

export function mintOfficialApiAssertionWork(
  turnContent: string,
  messages: readonly (Pick<ConversationMessage, "role" | "content"> &
    Partial<Pick<ConversationMessage, "message_id">>)[],
  datasetRevision?: string
): readonly MintedOfficialApiAssertionBinding[] {
  const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, messages);
  return mintOfficialApiAssertionWorkFromCorpus(sourceCorpus, messages.map((message) => message.message_id ?? null), datasetRevision);
}

export function mintOfficialApiAssertionWorkFromCorpus(
  sourceCorpus: string,
  messageIds: readonly (string | null)[],
  datasetRevision?: string
): readonly MintedOfficialApiAssertionBinding[] {
  const catalog = buildOfficialApiSourceAssertions(sourceCorpus);
  const indexed = new Map(
    indexSourceAssertions(sourceCorpus).map((assertion) => [assertion.assertion_id, assertion])
  );
  const sourceCorpusIdentity = computeOfficialApiSourceCorpusIdentity(sourceCorpus);
  const sourceTextDigest = digestSourceText(sourceCorpus);
  const roleMarkers = collectSourceRoleMarkers(sourceCorpus);
  return Object.freeze(catalog.map((member) => {
    const indexedAssertion = indexed.get(member.assertion_id);
    if (indexedAssertion === undefined) {
      throw new TypeError("catalog assertion missing from the indexed source catalog");
    }
    const sentenceText = sourceCorpus.slice(
      indexedAssertion.sentence.start,
      indexedAssertion.sentence.end
    );
    const enclosing = sentenceText.includes(indexedAssertion.text)
      ? sentenceText
      : indexedAssertion.text;
    const semanticIdentity = createAssertionSemanticIdentityWitness({
      formationContractVersion: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
      exactText: indexedAssertion.text,
      trustedRole: resolveTrustedRole(roleMarkers, indexedAssertion.start),
      semanticContext: resolveAssertionSemanticContext(
        indexedAssertion.text,
        enclosing,
        sourceCorpus.slice(
          Math.max(0, indexedAssertion.sentence.start - 512),
          indexedAssertion.sentence.start
        )
      )
    });
    const semanticKey = computeAssertionSemanticKey(semanticIdentity);
    const occurrenceIdentity = computeAssertionOccurrenceIdentity({
      sourceCorpusIdentity,
      assertionId: indexedAssertion.assertion_id,
      start: indexedAssertion.start,
      end: indexedAssertion.end,
      messageIds
    });
    return Object.freeze({
      semanticIdentity,
      binding: bindAssertionSource({
        semanticKey,
        sourceCorpusIdentity,
        sourceTextDigest,
        assertionTextDigest: digestSourceText(indexedAssertion.text),
        occurrenceIdentity,
        locator: {
          assertion_id: indexedAssertion.assertion_id,
          start: indexedAssertion.start,
          end: indexedAssertion.end
        },
        datasetRevision
      })
    });
  }));
}

export function mintOfficialApiAssertionBindings(
  turnContent: string,
  messages: readonly (Pick<ConversationMessage, "role" | "content"> &
    Partial<Pick<ConversationMessage, "message_id">>)[],
  datasetRevision?: string
): readonly AssertionSourceBinding[] {
  return Object.freeze(mintOfficialApiAssertionWork(
    turnContent, messages, datasetRevision
  ).map((item) => item.binding));
}

export { ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID };
export type { AssertionSourceBinding };

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

/** Bind a selected semantic work pack to the existing full-corpus catalog. */
export function buildOfficialApiSourceRequest(
  sourceCorpus: string,
  assertionIds: readonly number[]
): OfficialApiExtractionRequest {
  const catalog = new Map(buildOfficialApiSourceAssertions(sourceCorpus).map((row) => [row.assertion_id, row]));
  const assertions = assertionIds.map((id) => {
    const row = catalog.get(id);
    if (row === undefined) throw new Error("requested assertion is outside source corpus");
    return row;
  });
  if (new Set(assertionIds).size !== assertionIds.length) throw new Error("duplicate requested assertion");
  return buildRequest(assertions, computeOfficialApiSourceCorpusIdentity(sourceCorpus), 0, 1);
}

export function computeOfficialApiSourceCorpusIdentity(sourceCorpus: string): string {
  return createHash("sha256").update(JSON.stringify({
    contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
    source_corpus: sourceCorpus
  }), "utf8").digest("hex");
}

function resolveTrustedRole(
  markers: readonly { readonly start: number; readonly role: "user" | "assistant" }[],
  assertionStart: number
): "user" | "assistant" {
  const role = markers.filter((marker) => marker.start <= assertionStart).at(-1)?.role;
  if (role === undefined) throw new TypeError("assertion source role is unavailable");
  return role;
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
