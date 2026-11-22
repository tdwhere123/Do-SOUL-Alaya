import {
  AssociativeFactFrameSchema,
  groundAssociativeFactFrameSlots,
  type AssociativeFactFrame
} from "../associative-fact-frame.js";
import {
  OpenSemanticFactorGraphSchema,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph,
  type OpenSemanticFactorGraphProposal
} from "../../relations/open-semantic-factor-graph.js";

export function evidenceFactFrameGraphIsComplete(input: Readonly<{
  source_text: string;
  fact_frame: unknown;
  graph: Readonly<OpenSemanticFactorGraph | OpenSemanticFactorGraphProposal>;
}>): boolean {
  const frame = AssociativeFactFrameSchema.safeParse(input.fact_frame);
  if (!frame.success) return false;
  const graph = groundedGraph(input.graph, input.source_text);
  if (graph === null || graph.propositions.length !== 1) return false;
  const obligation = groundEvidenceFactFrameObligation(input.source_text, frame.data);
  return obligation !== null && graphMatchesObligation(graph, obligation);
}

type EvidenceGraphSlot = NonNullable<ReturnType<typeof groundAssociativeFactFrameSlots>>[number] &
  Readonly<{ position: number | null }>;
type EvidenceGraphObligation = Readonly<{
  predicate: EvidenceGraphSlot;
  arguments: readonly EvidenceGraphSlot[];
}>;

export function groundEvidenceFactFrameObligation(
  source: string,
  frame: AssociativeFactFrame
): EvidenceGraphObligation | null {
  const grounded = groundAssociativeFactFrameSlots(frame, source);
  if (grounded === null) return null;
  const relations = grounded.filter(({ role }) => role === "relation");
  const subjects = grounded.filter(({ role }) => role === "subject");
  const values = grounded.filter(({ role }) => role === "value");
  if (relations.length !== 1 || subjects.length !== 1 || values.length !== 1) return null;
  const argumentsInOrder = [subjects[0]!, ...grounded.filter(({ role }) =>
    role === "qualifier" || role === "time"), values[0]!];
  return Object.freeze({
    predicate: Object.freeze({ ...relations[0]!, position: null }),
    arguments: Object.freeze(argumentsInOrder.map((slot, position) =>
      Object.freeze({ ...slot, position })))
  });
}

function groundedGraph(
  graph: Readonly<OpenSemanticFactorGraph | OpenSemanticFactorGraphProposal>,
  source: string
): OpenSemanticFactorGraph | null {
  const parsed = OpenSemanticFactorGraphSchema.safeParse(graph);
  return parsed.success ? parsed.data : groundOpenSemanticFactorGraph(graph, source);
}

function graphMatchesObligation(
  graph: OpenSemanticFactorGraph,
  obligation: EvidenceGraphObligation
): boolean {
  if (graph.propositions.length !== 1) return false;
  const proposition = graph.propositions[0]!;
  const positions = proposition.arguments.map(({ position }) => position);
  if (new Set(positions).size !== positions.length ||
      positions.some((position, index) => position !== index)) return false;
  const predicate = graph.factors.find(({ factor_id }) =>
    factor_id === proposition.predicate_factor_id);
  if (!nodeMatchesReceipt(predicate, obligation.predicate) ||
      proposition.arguments.length !== obligation.arguments.length) return false;
  return obligation.arguments.every((slot) => {
    const argument = proposition.arguments.find(({ position }) => position === slot.position);
    if (argument?.reference_kind !== "factor") return false;
    return nodeMatchesReceipt(graph.factors.find(({ factor_id }) =>
      factor_id === argument.reference_id), slot);
  });
}

function nodeMatchesReceipt(
  node: OpenSemanticFactorGraph["factors"][number] | undefined,
  slot: EvidenceGraphSlot
): boolean {
  return node?.surface === slot.surface && node.source_span[0] === slot.source_span[0] &&
    node.source_span[1] === slot.source_span[1];
}
