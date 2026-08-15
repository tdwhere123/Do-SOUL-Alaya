import { SignalKind, type CandidateMemorySignal } from "@do-soul/alaya-protocol";

export const OPEN_SEMANTIC_OBSERVATION_OBJECT_KIND = "open_semantic_observation";

export const OFFICIAL_API_OBJECT_KINDS = Object.freeze([
  "preference",
  "decision",
  "constraint",
  "procedure",
  "hazard",
  "factual_policy",
  "exception",
  "glossary",
  "episode",
  "outcome",
  "reference",
  "task_state",
  "fact",
  "activity",
  OPEN_SEMANTIC_OBSERVATION_OBJECT_KIND
] as const);

export type OfficialApiObjectKind = (typeof OFFICIAL_API_OBJECT_KINDS)[number];

export type OfficialApiObjectKindProjection = Readonly<{
  readonly status: "rejected";
  readonly reason: "object_kind_missing" | "object_kind_not_allowed";
  readonly proposed_object_kind?: string;
}>;

const OFFICIAL_API_OBJECT_KIND_SET = new Set<string>(OFFICIAL_API_OBJECT_KINDS);
const PROPOSED_OBJECT_KIND_MAX_CHARS = 200;
const CLAIM_OBJECT_KINDS = new Set<OfficialApiObjectKind>([
  "decision",
  "constraint",
  "procedure",
  "hazard",
  "factual_policy",
  "exception",
  "glossary",
  "episode"
]);

export function projectOfficialApiObjectKind(value: string | undefined): Readonly<{
  readonly objectKind: OfficialApiObjectKind;
  readonly signalKind: CandidateMemorySignal["signal_kind"];
  readonly audit?: OfficialApiObjectKindProjection;
}> {
  const proposed = value?.trim();
  const objectKind = proposed !== undefined && OFFICIAL_API_OBJECT_KIND_SET.has(proposed)
    ? proposed as OfficialApiObjectKind
    : OPEN_SEMANTIC_OBSERVATION_OBJECT_KIND;
  return Object.freeze({
    objectKind,
    signalKind: signalKindForObjectKind(objectKind),
    ...(objectKind === proposed ? {} : {
      audit: Object.freeze({
        status: "rejected" as const,
        reason: proposed === undefined ? "object_kind_missing" as const :
          "object_kind_not_allowed" as const,
        ...(proposed === undefined ? {} : {
          proposed_object_kind: proposed.slice(0, PROPOSED_OBJECT_KIND_MAX_CHARS)
        })
      })
    })
  });
}

function signalKindForObjectKind(
  objectKind: OfficialApiObjectKind
): CandidateMemorySignal["signal_kind"] {
  if (objectKind === "preference") return SignalKind.POTENTIAL_PREFERENCE;
  if (CLAIM_OBJECT_KINDS.has(objectKind)) return SignalKind.POTENTIAL_CLAIM;
  return SignalKind.POTENTIAL_SEMANTIC_OBSERVATION;
}
