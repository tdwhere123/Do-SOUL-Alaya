import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  GuardSchema,
  normalizeMemoryObjectKeySurface,
  type Guard,
  type QueryInterpretationProposal
} from "@do-soul/alaya-protocol";

const SOURCE_PROPOSAL_LOOKUP_PREFIX = "source.proposal.v1";

export type QuerySourceRolePhrase = Readonly<{
  readonly role: string;
  readonly phrase: string;
}>;

export type QuerySourceLookupMode = "proposal" | "source_text";

export type AdoptedSourceProposal = Readonly<{
  readonly lookup_mode: QuerySourceLookupMode;
  readonly predicate_key: string;
  readonly arguments: readonly QuerySourceRolePhrase[];
  readonly qualifiers: readonly QuerySourceRolePhrase[];
}>;

type SketchWire = Readonly<{
  readonly m: QuerySourceLookupMode;
  readonly p: string;
  readonly a: readonly Readonly<{ readonly r: string; readonly k: string }>[];
  readonly q: readonly Readonly<{ readonly r: string; readonly k: string }>[];
}>;

export function adoptedSourceProposal(
  query: Readonly<{
    readonly source_guard?: Guard;
    readonly interpretation_proposal?: QueryInterpretationProposal;
  }>
): AdoptedSourceProposal | undefined {
  const guards = [
    ...(query.source_guard === undefined ? [] : [query.source_guard]),
    ...(query.interpretation_proposal?.conditions ?? [])
  ];
  for (const guard of guards) {
    try {
      const adopted = decodeSourceProposalPredicate(guard.predicate_name);
      if (adopted !== undefined) return adopted;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function decodeSourceProposalPredicate(
  predicateName: string | undefined
): AdoptedSourceProposal | undefined {
  const prefix = `${SOURCE_PROPOSAL_LOOKUP_PREFIX}:`;
  if (predicateName === undefined || !predicateName.startsWith(prefix)) return undefined;
  if (!sourceProposalPredicateFits(predicateName)) {
    throw new TypeError("Invalid source proposal lookup predicate");
  }
  const parsed: unknown = JSON.parse(predicateName.slice(prefix.length));
  if (!isSketchWire(parsed)) throw new TypeError("Invalid source proposal lookup sketch");
  return {
    lookup_mode: parsed.m,
    predicate_key: parsed.p,
    arguments: parsed.a.map((item) => ({ role: item.r, phrase: item.k })),
    qualifiers: parsed.q.map((item) => ({ role: item.r, phrase: item.k }))
  };
}

export function encodeSourceProposalPredicate(adopted: AdoptedSourceProposal): string {
  const packed = `${SOURCE_PROPOSAL_LOOKUP_PREFIX}:${JSON.stringify({
    m: adopted.lookup_mode,
    p: adopted.predicate_key,
    a: adopted.arguments.map((item) => ({ r: item.role, k: item.phrase })),
    q: adopted.qualifiers.map((item) => ({ r: item.role, k: item.phrase }))
  } satisfies SketchWire)}`;
  if (!sourceProposalPredicateFits(packed)) {
    throw new TypeError("Source proposal lookup exceeds the conditional-field predicate capacity");
  }
  return packed;
}

export function sourceProposalPhrases(adopted: AdoptedSourceProposal): readonly string[] {
  return [
    adopted.predicate_key,
    ...adopted.arguments.map((item) => item.phrase),
    ...adopted.qualifiers.map((item) => item.phrase)
  ];
}

export function normalizeSourceRolePhrase(item: QuerySourceRolePhrase): QuerySourceRolePhrase {
  return {
    role: normalizeMemoryObjectKeySurface(item.role),
    phrase: normalizeMemoryObjectKeySurface(item.phrase)
  };
}

function sourceProposalPredicateFits(predicateName: string): boolean {
  return GuardSchema.safeParse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "query_predicate",
    predicate_name: predicateName
  }).success;
}

function isSketchWire(value: unknown): value is SketchWire {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.m === "proposal" || record.m === "source_text")
    && typeof record.p === "string" && record.p.length > 0
    && isRoleWireList(record.a)
    && isRoleWireList(record.q);
}

function isRoleWireList(value: unknown): value is SketchWire["a"] {
  return Array.isArray(value) && value.every((item) =>
    item !== null && typeof item === "object" && typeof item.r === "string" && item.r.length > 0
    && typeof item.k === "string" && item.k.length > 0);
}
