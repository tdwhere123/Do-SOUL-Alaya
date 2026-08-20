export const PRODUCT_PHASES = [
  "formation",
  "composition",
  "activation",
  "selection",
  "delivery"
] as const;

export type ProductPhaseName = (typeof PRODUCT_PHASES)[number];
export type ProductPhaseAuthorityKind = "product" | "diagnostic_only" | "not_observed";
export type ProductPhaseStatusValue =
  | "formed"
  | "composed"
  | "selected"
  | "delivered"
  | "no_match"
  | "ineligible"
  | "unavailable"
  | "rejected"
  | "not_selected"
  | "not_delivered"
  | null;

export type ProductPhaseRecord = Readonly<{
  phase: ProductPhaseName;
  status: ProductPhaseStatusValue;
  authority: ProductPhaseAuthorityKind;
}>;

export type ProductPhaseLedger = Readonly<{
  formation: ProductPhaseRecord;
  composition: ProductPhaseRecord;
  activation: ProductPhaseRecord;
  selection: ProductPhaseRecord;
  delivery: ProductPhaseRecord;
}>;

export type ProductPhaseQuestion = Readonly<{
  query_open_semantic_factor_formation?: { readonly status?: string | null } | null;
  open_semantic_factor_composition?: { readonly status?: string | null } | null;
  open_semantic_factor_activation?: { readonly status?: string | null } | null;
  open_semantic_factor_archive?: { readonly replayable?: false } | null;
  delivered_results?: readonly unknown[];
  candidates?: readonly Readonly<{
    selection_order?: number | null;
    admission_attempts?: readonly Readonly<{ admitted: boolean }>[];
    final_rank?: number | null;
  }>[];
  fine_assessment_pruned_candidates?: readonly unknown[] | null;
}>;

export function readProductPhaseAuthority(
  question: ProductPhaseQuestion
): ProductPhaseLedger {
  const archived = question.open_semantic_factor_archive != null;
  const formationStatus = asStatus(question.query_open_semantic_factor_formation?.status, FORMATION_STATUSES);
  return {
    formation: {
      phase: "formation",
      status: formationStatus,
      authority: formationStatus === null ? "not_observed" : "product"
    },
    composition: semanticPhase(
      "composition",
      asStatus(question.open_semantic_factor_composition?.status, SEMANTIC_STATUSES),
      archived
    ),
    activation: semanticPhase(
      "activation",
      asStatus(question.open_semantic_factor_activation?.status, SEMANTIC_STATUSES),
      archived
    ),
    selection: selectionPhase(question),
    delivery: deliveryPhase(question)
  };
}

export function assertProductPhaseAuthority(
  question: ProductPhaseQuestion
): ProductPhaseLedger {
  const ledger = readProductPhaseAuthority(question);
  if (ledger.formation.status === "formed" &&
      ledger.composition.authority === "not_observed") {
    throw new Error("formed query factors were silently dropped before composition");
  }
  if (ledger.composition.status === "composed" &&
      ledger.activation.authority === "not_observed") {
    throw new Error("composed query factors were silently dropped before activation");
  }
  if (ledger.activation.authority === "product" &&
      ledger.activation.status === "composed" &&
      ledger.selection.authority !== "product") {
    throw new Error("activated query factors have no explicit selection observation");
  }
  return ledger;
}

function semanticPhase(
  phase: "composition" | "activation",
  status: ProductPhaseStatusValue,
  archived: boolean
): ProductPhaseRecord {
  if (archived) return { phase, status, authority: "diagnostic_only" };
  if (status === null) return { phase, status: null, authority: "not_observed" };
  return { phase, status, authority: "product" };
}

function selectionPhase(question: ProductPhaseQuestion): ProductPhaseRecord {
  const candidates = question.candidates ?? [];
  const observed = candidates.some((candidate) =>
    candidate.selection_order != null ||
    (candidate.admission_attempts?.length ?? 0) > 0
  );
  if (!observed) {
    return { phase: "selection", status: null, authority: "not_observed" };
  }
  const selected = candidates.some((candidate) =>
    candidate.selection_order != null ||
    (candidate.admission_attempts ?? []).some((attempt) => attempt.admitted)
  );
  return {
    phase: "selection",
    status: selected ? "selected" : "not_selected",
    authority: "product"
  };
}

function deliveryPhase(question: ProductPhaseQuestion): ProductPhaseRecord {
  // Live question schema requires delivered_results; only partial helpers omit it.
  if (question.delivered_results === undefined) {
    return { phase: "delivery", status: null, authority: "not_observed" };
  }
  return {
    phase: "delivery",
    status: question.delivered_results.length > 0 ? "delivered" : "not_delivered",
    authority: "product"
  };
}

const FORMATION_STATUSES = new Set<string>([
  "formed", "ineligible", "unavailable", "rejected"
]);
const SEMANTIC_STATUSES = new Set<string>([
  "composed", "no_match", "ineligible", "unavailable", "rejected"
]);

function asStatus(
  value: string | null | undefined,
  allowed: ReadonlySet<string>
): ProductPhaseStatusValue {
  if (value == null) return null;
  if (!allowed.has(value)) {
    throw new Error("unrecognized product phase status cannot become authority");
  }
  return value as ProductPhaseStatusValue;
}
