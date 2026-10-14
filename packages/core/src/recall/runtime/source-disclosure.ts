import { compareUtcInstants, SourceDisclosureSchema, type SourceDisclosure, type SourceRepresentation } from "@do-soul/alaya-protocol";

type CheckedSource = Readonly<{ event_time?: string | null; valid_from?: string | null; valid_to?: string | null;
  source_representation?: SourceRepresentation }>;

/** Checked source metadata is optional for reductions; absence remains explicit. */
export function projectSourceDisclosure(input: Readonly<{
  material_kind: SourceDisclosure["material_kind"];
  evaluated_as_of: string;
  source?: CheckedSource;
  proof_use?: SourceDisclosure["proof_use"]["kind"];
}>): SourceDisclosure {
  const from = input.source?.valid_from;
  const to = input.source?.valid_to;
  const validity = input.source === undefined
    ? { kind: "unknown" as const, reason: "unbound" as const }
    : from === undefined || to === undefined
      ? { kind: "unknown" as const, reason: "metadata_unavailable" as const }
      : from === null
        ? { kind: "unknown" as const, reason: "not_recorded" as const }
        : to === null
          ? { kind: "open" as const, from }
          : { kind: "bounded" as const, from, to_exclusive: to };
  const lower = from === null || from === undefined ? undefined : compareUtcInstants(input.evaluated_as_of, from);
  const upper = to === null || to === undefined ? undefined : compareUtcInstants(input.evaluated_as_of, to);
  const temporal_state = validity.kind === "unknown" || lower === undefined ||
    (validity.kind === "bounded" && upper === undefined) ? "unknown"
    : lower < 0 ? "before_start"
      : validity.kind === "bounded" && upper! >= 0 ? "at_or_after_end"
        : "within_interval";
  return SourceDisclosureSchema.parse({
    material_kind: input.material_kind === "original_body" ? input.source?.source_representation?.kind ?? "unknown" : input.material_kind,
    source_binding: input.source === undefined ? "unbound" : "checked_record",
    ...(input.source?.source_representation === undefined ? {} : { source_representation: input.source.source_representation }),
    evaluated_as_of: input.evaluated_as_of,
    source_time: input.source === undefined
      ? { kind: "unknown", reason: "unbound" }
      : input.source.event_time === undefined
        ? { kind: "unknown", reason: "metadata_unavailable" }
        : input.source.event_time === null
          ? { kind: "unknown", reason: "not_recorded" }
          : { kind: "known", at: input.source.event_time },
    validity,
    temporal_state,
    proof_use: input.proof_use === "conditional_support"
      ? { kind: "conditional_support", qualification: "not_world_claim" }
      : { kind: "source_only", qualification: "not_current_proof" }
  });
}
