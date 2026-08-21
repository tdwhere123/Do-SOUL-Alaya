import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeOpenSemanticFactorFormation } from
  "../../../../../semantic/open-semantic-factor-formation.js";

interface SealedLiveFormation {
  readonly source_kind: "evidence" | "query";
  readonly source_text: string;
  readonly source_sha256: string;
  readonly producer_operator_id: string;
  readonly capture_digest: string;
  readonly graph: {
    readonly schema_version: 2;
    readonly source_kind: "evidence" | "query";
    readonly result_variable_ids: readonly string[];
    readonly propositions: readonly unknown[];
    readonly factors: readonly GroundedNode[];
    readonly variables: readonly GroundedVariable[];
  };
}

interface GroundedNode {
  readonly factor_id: string;
  readonly surface: string;
  readonly semantic_identity: string;
  readonly source_span: readonly [number, number];
}

interface GroundedVariable {
  readonly variable_id: string;
  readonly surface: string;
  readonly source_span: readonly [number, number];
}

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "g8-live-q2q3-formations.json"),
  "utf8"
)) as Readonly<Record<string, SealedLiveFormation>>;

export function rematerializeG8LiveFormation(key: keyof typeof FIXTURE) {
  const sealed = FIXTURE[key];
  if (sealed === undefined) throw new Error(`missing G8 live formation ${String(key)}`);
  const capture = materializeOpenSemanticFactorFormation({
    source_kind: sealed.source_kind,
    source_text: sealed.source_text,
    proposal: {
      schema_version: 1,
      producer_operator_id: sealed.producer_operator_id,
      source_text: sealed.source_text,
      graph: toProposalGraph(sealed.source_text, sealed.graph)
    }
  });
  if (capture.source_sha256 !== sealed.source_sha256 ||
      capture.capture_digest !== sealed.capture_digest ||
      capture.producer_operator_id !== sealed.producer_operator_id ||
      capture.status !== "formed") {
    throw new Error(`G8 live formation ${String(key)} drifted from sealed producer identity`);
  }
  return capture;
}

function toProposalGraph(
  sourceText: string,
  graph: SealedLiveFormation["graph"]
) {
  return {
    schema_version: graph.schema_version,
    source_kind: graph.source_kind,
    result_variable_ids: graph.result_variable_ids,
    propositions: graph.propositions,
    factors: graph.factors.map((factor) => ({
      factor_id: factor.factor_id,
      surface: factor.surface,
      semantic_identity: factor.semantic_identity,
      source_occurrence: occurrenceIndex(sourceText, factor.surface, factor.source_span[0])
    })),
    variables: graph.variables.map((variable) => ({
      variable_id: variable.variable_id,
      surface: variable.surface,
      source_occurrence: occurrenceIndex(sourceText, variable.surface, variable.source_span[0])
    }))
  };
}

function occurrenceIndex(sourceText: string, surface: string, start: number): number {
  let offset = 0;
  let index = 0;
  while (offset <= sourceText.length) {
    const found = sourceText.indexOf(surface, offset);
    if (found < 0) {
      throw new Error(`sealed surface is not in source text: ${surface}`);
    }
    if (found === start) return index;
    index += 1;
    offset = found + surface.length;
  }
  throw new Error(`sealed source_span does not match producer occurrence: ${surface}`);
}
