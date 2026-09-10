import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  canonicalIndexEntryIdentity,
  productStateKeyFromIndexEntry,
  reachableMilligradesOf,
  type Continuation,
  type EnumerationPolicy,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type InformationIndex,
  type ProductUpdate,
  type ProductUpdateKind
} from "@do-soul/alaya-protocol";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { interpretationIdentity } from "../conditional-field/query/compile-query-identity.js";
import { compareText } from "../../shared/compare-text.js";
import { stableStringify } from "../../shared/stable-stringify.js";

export type ProjectionProgress = NonNullable<FieldEngineState["projection_progress"]>;
export type EmittedRevisions = Readonly<Record<string, string>>;

export const OFFSET_CURSOR = /^offset-(\d+)$/u;
export const RESUME_CURSOR = /^o(\d+)(?:\|(.*))?$/u;
export const PROJECTION_CURSOR = /^p(\d+)(?:g(\d+))?(?:r(\d+))?(?:e(\d+))?$/u;

const ISSUED_MAX = 32;
const FIELD_RESUME_MAX = 32;
const ISSUED_PAGES = new Map<string, IssuedDelivery>();
const INDEX_ISSUED_DELIVERY = new WeakMap<InformationIndex, string>();
const FIELD_RESUME = new Map<string, Readonly<{ state: FieldEngineState; token_digest: string }>>();

export type IssuedDelivery = Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly delivery_id: string;
  readonly member_ids: readonly string[];
  readonly index: InformationIndex;
}>;

export function indexEntryRevision(entry: IndexEntry): string {
  const { target, ...membership } = entry;
  const { span: _span, ...root } = target.kind === "source_evidence" ? target : { ...target, span: undefined };
  return createHash("sha256").update(stableStringify({ ...membership, target: root })).digest("hex");
}

export function productIdOfEntry(entry: IndexEntry): string {
  return productStateNodeId(productStateKeyFromIndexEntry(entry));
}

export function compareIndexEntries(
  left: IndexEntry,
  right: IndexEntry,
  policy: EnumerationPolicy
): number {
  if (policy === "associative") {
    const grade = right.association_milligrades - left.association_milligrades;
    if (grade !== 0) return grade;
  }
  return compareText(canonicalIndexEntryIdentity(left), canonicalIndexEntryIdentity(right));
}

export function sortIndexEntries(
  entries: readonly IndexEntry[],
  policy: EnumerationPolicy = "canonical"
): IndexEntry[] {
  return [...entries].sort((left, right) => compareIndexEntries(left, right, policy));
}

export function compareFieldValues(
  left: FieldValue,
  right: FieldValue,
  policy: EnumerationPolicy
): number {
  if (policy === "associative") {
    const leftGrade = reachableMilligradesOf(left) ?? -1;
    const rightGrade = reachableMilligradesOf(right) ?? -1;
    const grade = rightGrade - leftGrade;
    if (grade !== 0) return grade;
  }
  return compareText(canonicalFieldIdentity(left), canonicalFieldIdentity(right));
}

export function sortFieldValues(
  values: readonly FieldValue[],
  policy: EnumerationPolicy
): FieldValue[] {
  return [...values].sort((left, right) => compareFieldValues(left, right, policy));
}

export function emittedRevisionsOf(input: Readonly<{
  readonly delivered_product_ids?: ReadonlySet<string>;
  readonly delivered_entry_revisions?: EmittedRevisions;
  readonly prior_continuation?: Continuation | null;
}>): EmittedRevisions {
  return {
    ...input.prior_continuation?.emitted_revisions,
    ...input.delivered_entry_revisions
  };
}

export function mergeCommittedRevisions(
  prior: EmittedRevisions,
  entries: readonly IndexEntry[]
): Record<string, string> {
  const next = { ...prior };
  for (const entry of entries) {
    next[productIdOfEntry(entry)] = indexEntryRevision(entry);
  }
  return next;
}

export function productUpdateFor(entry: IndexEntry, previousRevision: string | undefined): ProductUpdate {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    product: productStateKeyFromIndexEntry(entry),
    update_kind: updateKindFor(entry, previousRevision),
    revision: indexEntryRevision(entry),
    ...(previousRevision === undefined || previousRevision.length === 0
      ? {}
      : { previous_revision: previousRevision })
  };
}

export function missingEmittedIdentities(
  emitted: EmittedRevisions,
  values: readonly FieldValue[]
): readonly string[] {
  if (Object.keys(emitted).length === 0) return [];
  const present = new Set(values.map((value) => productStateNodeId(value.state)));
  return Object.keys(emitted).filter((id) => !present.has(id));
}

export function encodeResumeCursor(count: number, emittedKeys: readonly string[]): string | null {
  const cursor = `o${String(count)}|${identityDigest(emittedKeys)}`;
  return cursor.length >= 1 && cursor.length <= 256 ? cursor : null;
}

export function resumeDigest(cursor: string): string | undefined {
  const resume = RESUME_CURSOR.exec(cursor);
  const suffix = resume?.[2];
  return suffix === undefined || suffix.length === 0 ? undefined : suffix;
}

export function identityDigest(keys: readonly string[]): string {
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

export function continuationCursorInvalid(input: Readonly<{
  readonly page_offset?: number;
  readonly view: Readonly<{ readonly enumeration_policy?: EnumerationPolicy }>;
  readonly prior_continuation?: Continuation | null;
}>): boolean {
  if (input.page_offset !== undefined) return false;
  const cursor = input.prior_continuation?.cursor;
  if (cursor === undefined) return false;
  const associative = (input.view.enumeration_policy ?? "canonical") === "associative";
  const hasEmitted = input.prior_continuation?.emitted_revisions !== undefined;
  if (associative && OFFSET_CURSOR.test(cursor) && !hasEmitted) return true;
  if (associative && RESUME_CURSOR.test(cursor) && !hasEmitted) return true;
  return !OFFSET_CURSOR.test(cursor) && !RESUME_CURSOR.test(cursor) && !PROJECTION_CURSOR.test(cursor);
}

export function continuationPolicyMismatch(input: Readonly<{
  readonly view: Readonly<{
    readonly enumeration_policy?: EnumerationPolicy;
    readonly result_kind_view?: "mixed" | "memory_only" | "source_only";
    readonly protocol_version?: number;
    readonly supported_result_kinds?: Continuation["supported_result_kinds"];
    readonly cap_contracts?: Continuation["cap_contracts"];
    readonly claim_demands?: Continuation["claim_demands"];
  }>;
  readonly authorized_scopes?: readonly string[];
  readonly prior_continuation?: Continuation | null;
}>): boolean {
  const prior = input.prior_continuation;
  if (prior === undefined || prior === null) return false;
  if ((prior.enumeration_policy ?? "canonical") !== (input.view.enumeration_policy ?? "canonical")) return true;
  if ((prior.result_kind_view ?? "mixed") !== (input.view.result_kind_view ?? "mixed")) return true;
  if ((prior.protocol_version ?? null) !== (input.view.protocol_version ?? null)) return true;
  if (stableStringify([...(prior.supported_result_kinds ?? [])].sort(compareText))
    !== stableStringify([...(input.view.supported_result_kinds ?? [])].sort(compareText))) return true;
  if (stableStringify(prior.cap_contracts ?? null) !== stableStringify(input.view.cap_contracts ?? null)) return true;
  if (stableStringify(prior.claim_demands ?? null) !== stableStringify(input.view.claim_demands ?? null)) return true;
  if (prior.authorized_scopes === undefined || input.authorized_scopes === undefined) return false;
  return identityDigest([...(prior.authorized_scopes)].sort(compareText))
    !== identityDigest([...input.authorized_scopes].sort(compareText));
}

export function resumeIndexProjection(state: FieldEngineState, snapshot: FieldSnapshot): ProjectionProgress {
  const references = [state.binding.kind === "bound" ? state.binding.values : snapshot.values,
    state.binding.kind === "bound" ? state.binding.guaranteed_values : null,
    state.ordered_identities, state.seeds, state.facets,
    state.claims, state.claim_propositions, state.transitions, state.derivations, state.transition_derivations
  ];
  const prior = state.projection_progress;
  const same = prior !== undefined && references.every((reference, index) => reference === prior.input_references[index]);
  const generation = (prior?.generation ?? 0) + (same ? 0 : 1);
  return {
    revision: `projection-generation:${generation}`,
    input_references: references,
    generation,
    offset: same ? prior!.offset : 0,
    delivered_entries: prior?.delivered_entries ?? {},
    ...(same && prior?.facet_offset !== undefined ? { facet_offset: prior.facet_offset } : {}),
    ...(prior?.facet_index !== undefined ? { facet_index: prior.facet_index } : {})
  };
}

export function retainIndexDelivery(
  progress: ProjectionProgress,
  entries: readonly IndexEntry[],
  first: boolean
): Readonly<{ progress: ProjectionProgress; bytes: number }> {
  const delivered = { ...progress.delivered_entries };
  let bytes = first ? 256 : 0;
  for (const entry of entries) {
    const key = productIdOfEntry(entry);
    if (delivered[key] === undefined) bytes += 128 + Buffer.byteLength(key, "utf8");
    delivered[key] = indexEntryRevision(entry);
  }
  return { progress: { ...progress, delivered_entries: delivered }, bytes };
}

export function retainCommittedRevisions(
  progress: ProjectionProgress,
  committed: EmittedRevisions,
  first: boolean
): Readonly<{ progress: ProjectionProgress; bytes: number }> {
  let bytes = first ? 256 : 0;
  for (const [key, revision] of Object.entries(committed)) {
    if (progress.delivered_entries[key] === undefined) bytes += 128 + Buffer.byteLength(key, "utf8");
    else if (progress.delivered_entries[key] === revision) continue;
  }
  return { progress: { ...progress, delivered_entries: committed }, bytes };
}

export function rememberIssuedDelivery(input: Readonly<{
  readonly query_key: string;
  readonly request_digest: string;
  readonly index: InformationIndex;
}>): string {
  const delivery_id = createHash("sha256").update(JSON.stringify([
    input.request_digest, input.index.query_id, input.index.snapshot_id,
    input.index.entries.map(productIdOfEntry)
  ])).digest("hex").slice(0, 32);
  ISSUED_PAGES.set(input.request_digest, {
    query_key: input.query_key,
    request_digest: input.request_digest,
    delivery_id,
    member_ids: input.index.entries.map(productIdOfEntry),
    index: input.index
  });
  while (ISSUED_PAGES.size > ISSUED_MAX) {
    const oldest = ISSUED_PAGES.keys().next().value;
    if (oldest === undefined) break;
    ISSUED_PAGES.delete(oldest);
  }
  bindIssuedDeliveryId(input.index, delivery_id);
  return delivery_id;
}

export function bindIssuedDeliveryId(index: InformationIndex, deliveryId: string): void {
  INDEX_ISSUED_DELIVERY.set(index, deliveryId);
}

export function issuedDeliveryIdOf(index: InformationIndex): string | undefined {
  return INDEX_ISSUED_DELIVERY.get(index);
}

export function replayIssuedDelivery(requestDigest: string): IssuedDelivery | undefined {
  return ISSUED_PAGES.get(requestDigest);
}

export function evictIssuedDeliveries(queryKey: string): readonly string[] {
  const removed: string[] = [];
  for (const [digest, issued] of ISSUED_PAGES) {
    if (issued.query_key === queryKey) {
      ISSUED_PAGES.delete(digest);
      removed.push(digest);
    }
  }
  return removed;
}

export function issuedDeliveryRevoked(
  issued: IssuedDelivery,
  eligibleIds: ReadonlySet<string>
): boolean {
  return issued.member_ids.some((id) => !eligibleIds.has(id));
}

export function replayIssuedIndex(issued: IssuedDelivery): InformationIndex {
  const replayed = { ...issued.index, page_purpose: "retry" as const };
  bindIssuedDeliveryId(replayed, issued.delivery_id);
  return replayed;
}

export function fieldResumeKey(queryId: string, snapshotId: string, interpretationId: string): string {
  return `${queryId}\0${snapshotId}\0${interpretationId}\0v1`;
}

export function continuationDigest(continuation: Continuation): string {
  return createHash("sha256").update(JSON.stringify([
    continuation.schema_version, continuation.continuation_id, continuation.query_id,
    continuation.snapshot_id, continuation.result_version, continuation.expires_at,
    continuation.cursor, continuation.interpretation_id, continuation.interpretation_clock
  ])).digest("hex");
}

export function rememberField(state: FieldEngineState, continuation: Continuation | null): void {
  const key = fieldResumeKey(
    state.query_id,
    state.snapshot_id,
    interpretationIdentity({ interpretation_clock: state.interpretation.interpretation_clock })
  );
  FIELD_RESUME.delete(key);
  if (continuation === null) return;
  FIELD_RESUME.set(key, { state, token_digest: continuationDigest(continuation) });
  while (FIELD_RESUME.size > FIELD_RESUME_MAX) {
    const oldest = FIELD_RESUME.keys().next().value;
    if (oldest === undefined) break;
    FIELD_RESUME.delete(oldest);
  }
}

export function restoreField(
  continuation: Continuation | null | undefined,
  interpretationClock?: string,
  interpretationId?: string
): FieldEngineState | undefined {
  if (continuation === undefined || continuation === null) return undefined;
  const retained = FIELD_RESUME.get(fieldResumeKey(
    continuation.query_id,
    continuation.snapshot_id,
    continuation.interpretation_id
      ?? interpretationId
      ?? interpretationIdentity({ interpretation_clock: interpretationClock })
  ));
  if (retained === undefined) return undefined;
  const digest = continuationDigest(continuation);
  if (replayIssuedDelivery(digest) !== undefined) return retained.state;
  return retained.token_digest === digest ? retained.state : undefined;
}

function updateKindFor(entry: IndexEntry, previousRevision: string | undefined): ProductUpdateKind {
  if (previousRevision === undefined || previousRevision.length === 0) return "proof";
  if (entry.claim !== "unknown") return "claim";
  if (entry.explanation_ids.length > 0) return "payload";
  return "proof";
}

function canonicalFieldIdentity(value: FieldValue): string {
  return canonicalIndexEntryIdentity({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target: value.state.target,
    ...(value.state.target.kind === "memory_entry" ? { object_id: value.state.target.object_id } : {}),
    hypothesis_id: value.state.hypothesis_id,
    output_binding: value.state.binding_context,
    program_state: value.state.program_state,
    time_state: value.state.time_state,
    role: "associated",
    association_milligrades: reachableMilligradesOf(value) ?? 0,
    claim: "unknown",
    explanation_ids: []
  });
}

