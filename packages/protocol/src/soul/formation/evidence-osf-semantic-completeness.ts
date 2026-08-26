import { z } from "zod";
import {
  AssociativeFactFrameSchema,
  AssociativeFactSlotRoleSchema,
  type AssociativeFactFrame,
  type AssociativeFactSlotRole,
  type EvidenceFactFrameFormationCapture
} from "../associative-fact-frame.js";
import {
  OpenSemanticFactorGraphSchema,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraph,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraphProposal
} from "../open-semantic-factor-graph.js";
import { canonicalJson } from "../selection/d0/canonical-json.js";

export const EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID =
  "evidence_osf_semantic_completeness_v2" as const;
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const Slot = z.object({ role: AssociativeFactSlotRoleSchema,
  surface: z.string().min(1), source_span: z.tuple([
    z.number().int().nonnegative(), z.number().int().positive()
  ]).readonly(), position: z.number().int().nonnegative().nullable() }).strict().readonly();

export const EvidenceOsfSemanticCompletenessReceiptSchema = z.object({
  schema_version: z.literal(1),
  operator_id: z.literal(EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID),
  status: z.enum(["certified", "rejected", "not_applicable"]),
  reason_code: z.enum(["complete", "upstream_not_formed",
    "invalid_fact_frame_obligation", "semantic_graph_incomplete"]),
  fact_frame_capture_digest: Digest,
  semantic_formation_capture_digest: Digest,
  predicate: Slot.nullable(), arguments: z.array(Slot).readonly(),
  arity: z.number().int().nonnegative().nullable(), receipt_digest: Digest
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "certified") !== (receipt.reason_code === "complete") ||
      (receipt.status === "certified" && (receipt.predicate === null ||
        receipt.arity !== receipt.arguments.length))) {
    context.addIssue({ code: "custom", message: "invalid semantic completeness state" });
  }
}).readonly();

export type EvidenceOsfSemanticCompletenessReceipt = z.infer<
  typeof EvidenceOsfSemanticCompletenessReceiptSchema
>;

export function evidenceFactFrameGraphIsComplete(input: Readonly<{
  source_text: string;
  fact_frame: unknown;
  graph: Readonly<OpenSemanticFactorGraph | OpenSemanticFactorGraphProposal>;
}>): boolean {
  const frame = AssociativeFactFrameSchema.safeParse(input.fact_frame);
  if (!frame.success) return false;
  const graph = groundedGraph(input.graph, input.source_text);
  if (graph === null || graph.propositions.length !== 1) return false;
  const obligation = frameObligation(input.source_text, frame.data);
  return obligation !== null && graphMatchesObligation(graph, obligation);
}

export function evidenceOsfSemanticCompletenessPreimage(value: Omit<
  EvidenceOsfSemanticCompletenessReceipt, "receipt_digest"
>): string {
  return canonicalJson(value);
}

export function verifyEvidenceOsfSemanticCompleteness(input: Readonly<{
  receipt: unknown;
  source_text: string;
  fact_frame: Readonly<EvidenceFactFrameFormationCapture>;
  semantic_formation: Readonly<OpenSemanticFactorFormationCapture>;
  sha256: (preimage: string) => string;
}>): EvidenceOsfSemanticCompletenessReceipt {
  const receipt = EvidenceOsfSemanticCompletenessReceiptSchema.parse(input.receipt);
  const { receipt_digest: _digest, ...body } = receipt;
  const digest = `sha256:${input.sha256(evidenceOsfSemanticCompletenessPreimage(body))}`;
  if (receipt.status !== "certified" || receipt.receipt_digest !== digest ||
      input.fact_frame.status !== "formed" || input.semantic_formation.status !== "formed" ||
      receipt.fact_frame_capture_digest !== input.fact_frame.capture_digest ||
      receipt.semantic_formation_capture_digest !== input.semantic_formation.capture_digest ||
      !receiptMatchesSource(receipt, input.source_text, input.fact_frame) ||
      !receiptMatchesGraph(receipt, input.semantic_formation.graph)) {
    throw new Error("evidence semantic completeness receipt mismatch");
  }
  return receipt;
}

function receiptMatchesSource(
  receipt: EvidenceOsfSemanticCompletenessReceipt,
  source: string,
  capture: EvidenceFactFrameFormationCapture
): boolean {
  const frameSlots = capture.fact_frame?.slots ?? [];
  const grounded = groundFrameSlots(source, frameSlots);
  if (grounded === null || receipt.predicate === null) return false;
  const subjects = grounded.filter(({ role }) => role === "subject");
  const relations = grounded.filter(({ role }) => role === "relation");
  const values = grounded.filter(({ role }) => role === "value");
  if (subjects.length !== 1 || relations.length !== 1 || values.length !== 1) return false;
  const argumentsInOrder = [subjects[0]!, ...grounded.filter(({ role }) =>
    role === "qualifier" || role === "time"), values[0]!];
  return slotEqual(receipt.predicate, { ...relations[0]!, position: null }) &&
    receipt.arguments.length === argumentsInOrder.length &&
    receipt.arguments.every((slot, position) => slotEqual(slot, {
      ...argumentsInOrder[position]!, position
    }));
}

function groundFrameSlots(
  source: string,
  slots: readonly Readonly<{ readonly role: AssociativeFactSlotRole; readonly text: string }>[]
): readonly Readonly<{ readonly role: AssociativeFactSlotRole; readonly surface: string;
  readonly source_span: readonly [number, number] }>[] | null {
  let cursor = 0;
  const grounded = slots.map(({ role, text }) => {
    const start = source.indexOf(text, cursor);
    if (start < 0) return null;
    cursor = start + text.length;
    return Object.freeze({ role, surface: text,
      source_span: Object.freeze([start, cursor]) as readonly [number, number] });
  });
  return grounded.some((slot) => slot === null) ? null : grounded as NonNullable<typeof grounded[number]>[];
}

type EvidenceGraphObligation = Readonly<{
  predicate: NonNullable<EvidenceOsfSemanticCompletenessReceipt["predicate"]>;
  arguments: EvidenceOsfSemanticCompletenessReceipt["arguments"];
}>;

function frameObligation(
  source: string,
  frame: AssociativeFactFrame
): EvidenceGraphObligation | null {
  const grounded = groundFrameSlots(source, frame.slots);
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

function slotEqual(
  left: NonNullable<EvidenceOsfSemanticCompletenessReceipt["predicate"]>,
  right: Readonly<{ readonly role: string; readonly surface: string;
    readonly source_span: readonly [number, number]; readonly position: number | null }>
): boolean {
  return left.role === right.role && left.surface === right.surface &&
    left.position === right.position && left.source_span[0] === right.source_span[0] &&
    left.source_span[1] === right.source_span[1];
}

function receiptMatchesGraph(
  receipt: EvidenceOsfSemanticCompletenessReceipt,
  graph: OpenSemanticFactorGraph | null
): boolean {
  if (graph === null || receipt.predicate === null) return false;
  return graphMatchesObligation(graph, {
    predicate: receipt.predicate,
    arguments: receipt.arguments
  });
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
  slot: NonNullable<EvidenceOsfSemanticCompletenessReceipt["predicate"]>
): boolean {
  return node?.surface === slot.surface && node.source_span[0] === slot.source_span[0] &&
    node.source_span[1] === slot.source_span[1];
}
