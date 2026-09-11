import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  compareUtcInstants,
  type Guard,
  type GuardInterval,
  type GuardVerdict,
  type QueryHole
} from "@do-soul/alaya-protocol";
import { sourceLiteralOccurs } from "../../../memory/evidence-create/source-utf8-hydrate.js";
import { SOURCE_FILTER_PREDICATE } from "./ordinary-language.js";

export const FROZEN_SOURCE_PREDICATE_NAMES = [
  "source.identity.v1",
  "source.literal.nfc.v1",
  "source.role.v1",
  "source.event_time.interval.v1",
  "source.evidence_link.v1"
] as const;

export const UNSUPPORTED_PREDICATE_HOLE_ID = "hole.predicate.unsupported";
export const UNSUPPORTED_POLICY_QUERY_ID = "unsupported-policy";

export type FrozenSourcePredicateName = (typeof FROZEN_SOURCE_PREDICATE_NAMES)[number];

const FROZEN_SOURCE_PREDICATE_SET: ReadonlySet<string> = new Set(FROZEN_SOURCE_PREDICATE_NAMES);

export type QueryPredicateClass =
  | { readonly kind: "missing" }
  | { readonly kind: "memory_filters" }
  | { readonly kind: "frozen"; readonly name: FrozenSourcePredicateName }
  | { readonly kind: "unknown"; readonly name: string };

export type SourcePredicateSubject = Readonly<{
  readonly workspace_id?: string;
  readonly root_kind?: string;
  readonly root_id?: string;
  readonly source_version?: string;
  readonly content?: string;
  readonly content_complete?: boolean;
  readonly literal_verdicts?: Readonly<Record<string, GuardVerdict>>;
  readonly role?: string;
  readonly event_time?: string | null;
  readonly evidence_object_id?: string | null;
  readonly evidence_verified?: boolean;
  readonly created_at?: string;
  readonly last_used_at?: string | null;
}>;

export function classifyQueryPredicate(name: string | undefined): QueryPredicateClass {
  if (name === undefined || name.length === 0) return { kind: "missing" };
  if (name.startsWith(SOURCE_FILTER_PREDICATE)) return { kind: "memory_filters" };
  if (FROZEN_SOURCE_PREDICATE_SET.has(name)) {
    return { kind: "frozen", name: name as FrozenSourcePredicateName };
  }
  return { kind: "unknown", name };
}

export function unsupportedPredicateHole(): QueryHole {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    hole_id: UNSUPPORTED_PREDICATE_HOLE_ID,
    variable: "q",
    status: "unresolved"
  };
}

export function evaluateFrozenSourcePredicate(
  name: FrozenSourcePredicateName,
  guard: Guard,
  subject: SourcePredicateSubject | undefined,
  literalNeedle?: string
): GuardVerdict {
  if (subject === undefined) return "unresolved";
  switch (name) {
    case "source.identity.v1":
      return identityVerdict(subject, guard.entity_id);
    case "source.literal.nfc.v1":
      return literalVerdict(subject, guard.entity_id ?? literalNeedle);
    case "source.role.v1":
      return roleVerdict(subject, guard.entity_id);
    case "source.event_time.interval.v1":
      return eventTimeVerdict(subject, guard.interval);
    case "source.evidence_link.v1":
      return evidenceLinkVerdict(subject);
  }
}

function identityVerdict(subject: SourcePredicateSubject, requiredRootId?: string): GuardVerdict {
  if (
    subject.workspace_id === undefined
    || subject.root_kind === undefined
    || subject.root_id === undefined
    || subject.source_version === undefined
  ) {
    return "unresolved";
  }
  if (subject.root_id.length === 0) return "false";
  if (requiredRootId !== undefined && requiredRootId !== subject.root_id) return "false";
  return "true";
}

function literalVerdict(subject: SourcePredicateSubject, needle: string | undefined): GuardVerdict {
  if (needle === undefined || needle.length === 0) return "unresolved";
  const streamed = subject.literal_verdicts?.[needle.normalize("NFC")];
  if (streamed !== undefined) return streamed;
  if (subject.content === undefined) return "unresolved";
  if (sourceLiteralOccurs(subject.content, needle)) return "true";
  // A bounded first chunk is not the whole body; miss is not absence.
  return subject.content_complete === false ? "unresolved" : "false";
}

function roleVerdict(subject: SourcePredicateSubject, required: string | undefined): GuardVerdict {
  if (subject.role === undefined) return "unresolved";
  if (required === undefined) return "true";
  return subject.role === required ? "true" : "false";
}

function eventTimeVerdict(
  subject: SourcePredicateSubject,
  interval: GuardInterval | undefined
): GuardVerdict {
  const stamp = subject.event_time;
  if (stamp === undefined || stamp === null) return "unresolved";
  if (interval === undefined) return compareUtcInstants(stamp, stamp) === undefined ? "unresolved" : "true";
  const lower = compareUtcInstants(stamp, interval.start);
  const upper = compareUtcInstants(stamp, interval.end);
  if (lower === undefined || upper === undefined) return "unresolved";
  return lower >= 0 && upper < 0 ? "true" : "false";
}

function evidenceLinkVerdict(subject: SourcePredicateSubject): GuardVerdict {
  if (subject.evidence_object_id === undefined) return "unresolved";
  if (subject.evidence_object_id === null || subject.evidence_object_id.length === 0) return "false";
  if (subject.evidence_verified !== true) return "unresolved";
  return "true";
}
