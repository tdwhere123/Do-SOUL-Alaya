const ADMISSION_PLANES = Object.freeze([
  "protected_winner",
  "activation",
  "object_probe",
  "lexical",
  "evidence_anchor",
  "facet_concept",
  "domain_tag_cluster",
  "session_surface_cohort",
  "temporal_window",
  "source_proximity",
  "graph_expansion",
  "path_expansion",
  "semantic_supplement"
] as const);

const SOURCE_LABELS = new Set<string>([
  ...ADMISSION_PLANES,
  ...ADMISSION_PLANES.map((plane) => `plane:${plane}`),
  "query_probe_lexical",
  "warm_cascade",
  "cold_cascade",
  "semantic_supplement",
  "graph_support",
  "path_plasticity",
  "ranked_recall",
  "workspace_local",
  "project",
  "global",
  "advisory",
  "lexical",
  "lexical_expanded",
  "evidence_fts"
]);

export function readDiagnosticLabelArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return strings.length === value.length
    ? strings.filter((item) => SOURCE_LABELS.has(item))
    : null;
}
