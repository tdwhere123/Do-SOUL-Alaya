/**
 * Query-time entity extraction port and candidate shape.
 *
 * invariant: entity extraction is query-time only. Implementations may
 * NOT write to `memory_graph_edges`, propose/accept, or any durable-truth
 * surface. The recall service consumes the candidate list to widen
 * lexical FTS seeding and to seed graph_expansion; entity candidates do
 * not themselves enter propose/accept paths.
 *
 * see also: packages/core/src/entity-extraction-rules.ts RuleBasedEntityExtractor
 * see also: packages/core/src/recall-service.ts collectEntityDerivedSeeds
 */

export type EntityCandidateKind =
  | "quoted"
  | "proper_noun"
  | "code_ref"
  | "path"
  | "package"
  | "task_ref"
  | "cjk_phrase"
  | "unknown";

export interface EntityCandidate {
  /** Original surface form (case + punctuation preserved). */
  readonly surface: string;
  /** NFKC + lower-cased form used for FTS comparison. */
  readonly normalized: string;
  /** Which rule lane produced this candidate. */
  readonly kind: EntityCandidateKind;
  /** Per-kind trust level in [0, 1]; sort key for max-entities cap. */
  readonly confidence: number;
  /** Inclusive-exclusive char offsets into the raw query string. */
  readonly source_offset?: readonly [number, number];
}

export interface EntityExtractionPort {
  extract(
    query: string,
    options?: Readonly<{ readonly maxEntities?: number }>
  ): Promise<readonly Readonly<EntityCandidate>[]>;
}
