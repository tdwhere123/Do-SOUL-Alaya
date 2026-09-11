import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  EMITTED_REVISIONS_MAX,
  productStateKeyFromIndexEntry,
  sharedProductIdentity,
  sourceEvidenceRootTarget,
  type Continuation,
  type IndexEntry,
  type InformationIndex,
  type PagePurpose,
  type ProductStateKey,
  type ProductUpdate,
  type ProductUpdateKind
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";

export type ProductComponentState = Readonly<{
  readonly membership_revision: string;
  readonly proof_revision: string;
  readonly claim_revision: string;
  readonly explanation_revision: string;
  readonly payload_revision: string;
  readonly membership_present: boolean;
}>;

export type EmittedProductLedger = Readonly<Record<string, ProductComponentState>>;
export type EmittedRevisions = Readonly<Record<string, string>>;

const INDEX_COMMITTED_REVISIONS = new WeakMap<InformationIndex, EmittedRevisions>();
const INDEX_COMMITTED_PRODUCTS = new WeakMap<InformationIndex, EmittedProductLedger>();
const CONTINUATION_PRODUCTS = new WeakMap<Continuation, EmittedProductLedger>();

const COMPONENT_KINDS: readonly (readonly [keyof ProductComponentState, ProductUpdateKind])[] = [
  ["proof_revision", "proof"],
  ["claim_revision", "claim"],
  ["explanation_revision", "payload"],
  ["payload_revision", "payload"]
];

function digestOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function targetRoot(entry: IndexEntry): IndexEntry["target"] {
  return entry.target.kind === "source_evidence" ? sourceEvidenceRootTarget(entry.target) : entry.target;
}

function payloadIdentity(entry: IndexEntry): unknown {
  if (entry.target.kind === "source_evidence") {
    return entry.target.span ?? entry.target.content_digest;
  }
  return entry.target.source_revision;
}

export function productComponentState(entry: IndexEntry): ProductComponentState {
  const root = targetRoot(entry);
  return {
    membership_revision: digestOf({
      target: root,
      hypothesis_id: entry.hypothesis_id,
      output_binding: entry.output_binding,
      program_state: entry.program_state,
      time_state: entry.time_state,
      role: entry.role
    }),
    proof_revision: digestOf({
      association_milligrades: entry.association_milligrades,
      role: entry.role,
      target: root
    }),
    claim_revision: digestOf({
      claim: entry.claim,
      claim_proposition_id: entry.claim_proposition_id,
      claim_proposition: entry.claim_proposition
    }),
    explanation_revision: digestOf(entry.explanation_ids),
    payload_revision: digestOf(payloadIdentity(entry)),
    membership_present: true
  };
}

export function retractedComponentState(previous: ProductComponentState): ProductComponentState {
  return { ...previous, membership_present: false };
}

export function productUpdatesBetween(
  product: ProductStateKey,
  previous: ProductComponentState | undefined,
  current: ProductComponentState | undefined
): ProductUpdate[] {
  if (previous?.membership_present === true && current?.membership_present !== true) {
    return [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      product,
      update_kind: "retraction",
      revision: previous.membership_revision,
      previous_revision: previous.membership_revision
    }];
  }
  if (previous === undefined || current === undefined || previous.membership_present !== true) {
    return [];
  }
  const updates: ProductUpdate[] = [];
  for (const [field, kind] of COMPONENT_KINDS) {
    const revision = current[field];
    const previousRevision = previous[field];
    if (revision === previousRevision || typeof revision !== "string" || typeof previousRevision !== "string") {
      continue;
    }
    updates.push({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      product,
      update_kind: kind,
      revision,
      previous_revision: previousRevision
    });
  }
  return updates;
}

export function mergeCommittedProductStates(
  prior: EmittedProductLedger,
  members: readonly IndexEntry[],
  updates: readonly IndexEntry[],
  retractions: readonly ProductStateKey[]
): EmittedProductLedger {
  const next: Record<string, ProductComponentState> = { ...prior };
  for (const entry of [...members, ...updates]) {
    next[sharedProductIdentity(productStateKeyFromIndexEntry(entry))] = productComponentState(entry);
  }
  for (const product of retractions) {
    const id = sharedProductIdentity(product);
    const previous = next[id];
    if (previous !== undefined) next[id] = retractedComponentState(previous);
  }
  const keys = Object.keys(next);
  if (keys.length <= EMITTED_REVISIONS_MAX) return next;
  for (const key of keys.slice(0, keys.length - EMITTED_REVISIONS_MAX)) {
    delete next[key];
  }
  return next;
}

export function pagePurposeFor(input: Readonly<{
  readonly payload_expansion: boolean;
  readonly member_count: number;
  readonly update_count: number;
}>): PagePurpose {
  if (input.payload_expansion) return "payload";
  if (input.member_count > 0) return "membership";
  if (input.update_count > 0) return "update";
  return "membership";
}

export function bindCommittedDelivery(
  index: InformationIndex,
  revisions: EmittedRevisions,
  products: EmittedProductLedger
): void {
  INDEX_COMMITTED_REVISIONS.set(index, revisions);
  INDEX_COMMITTED_PRODUCTS.set(index, products);
  if (index.continuation !== null) CONTINUATION_PRODUCTS.set(index.continuation, products);
}

export function committedRevisionsOf(index: InformationIndex): EmittedRevisions | undefined {
  return INDEX_COMMITTED_REVISIONS.get(index);
}

export function committedProductStatesOf(
  holder: InformationIndex | Continuation | null | undefined
): EmittedProductLedger | undefined {
  if (holder == null) return undefined;
  if ("entries" in holder) return INDEX_COMMITTED_PRODUCTS.get(holder);
  return CONTINUATION_PRODUCTS.get(holder);
}
