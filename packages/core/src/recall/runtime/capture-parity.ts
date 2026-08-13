import { isDeepStrictEqual } from "node:util";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field/field-identity.js";
import { stableStringify } from "../../shared/stable-stringify.js";
import type { RecallResult } from "./recall-service-results.js";

export type CaptureParityAxis = "channels" | "geometry" | "membership";
export type CaptureParityMask = "hydrate_vs_compute" | "embedding_observation";
export const CAPTURE_PARITY_GEOMETRY_BASIS =
  "runtime_emitted_answer_shape_plan_and_query_probes" as const;
export type CaptureParityGeometryBasis = typeof CAPTURE_PARITY_GEOMETRY_BASIS;

export interface CaptureParityChannel {
  readonly channel_id: string;
  readonly status: string;
  readonly observation_keys: readonly string[];
}

export interface CaptureParityGeometry {
  // Geometry compares runtime-emitted answer_shape_plan + query_probes only;
  // reconstructed demand matches by construction and cannot independently fail.
  readonly answer_shape_plan: unknown;
  readonly probes: unknown;
}

export interface CaptureParityMember {
  readonly object_kind: string;
  readonly object_id: string;
}

export interface CaptureParityView {
  readonly question_id: string;
  readonly channels: readonly CaptureParityChannel[];
  readonly geometry: CaptureParityGeometry;
  readonly membership: readonly CaptureParityMember[];
  readonly assessment_path: "legacy" | "snapshot" | null;
}

export interface CaptureParityDifference {
  readonly question_id: string;
  readonly axis: CaptureParityAxis;
  readonly message: string;
}

export interface CaptureParityAxisDigests {
  readonly channels: RecallFieldDigest;
  readonly geometry: RecallFieldDigest;
  readonly membership: RecallFieldDigest;
}

export interface CaptureParityQuestionDigests {
  readonly off: CaptureParityAxisDigests;
  readonly on: CaptureParityAxisDigests;
}

export interface CaptureParityQuestionVerdict {
  readonly question_id: string;
  readonly channels: "pass" | "fail";
  readonly geometry: "pass" | "fail";
  readonly membership: "pass" | "fail";
  readonly exercised_masks: readonly CaptureParityMask[];
  readonly digests: CaptureParityQuestionDigests;
  readonly difference: CaptureParityDifference | null;
}

export interface CaptureParityReport {
  readonly schema_version: 2;
  readonly geometry_basis: CaptureParityGeometryBasis;
  readonly parity: boolean;
  readonly question_count: number;
  readonly sidecar_question_count: number;
  readonly window_length: number;
  readonly first_difference: CaptureParityDifference | null;
  readonly summary: {
    readonly channels: "pass" | "fail";
    readonly geometry: "pass" | "fail";
    readonly membership: "pass" | "fail";
    readonly exercised_masks: readonly CaptureParityMask[];
  };
  readonly questions: readonly CaptureParityQuestionVerdict[];
}

type FieldCaptureRow = Readonly<{
  readonly channel: Readonly<{
    readonly channel_id: string;
    readonly status: string;
    readonly observations: readonly Readonly<{ readonly candidate_key: string }>[];
  }>;
}>;

const EMBEDDING_CHANNEL_IDS = new Set([
  "object_embedding_pool",
  "object_embedding_workspace",
  "evidence_semantic"
]);

export function requireRetrievalFieldCaptures<T>(
  questionId: string,
  captures: readonly T[] | null | undefined
): readonly T[] {
  if (captures === null || captures === undefined) {
    throw new Error(
      `capture parity retrieval_field_captures missing (question_id=${questionId})`
    );
  }
  return captures;
}

export function mapCaptureParityChannels(
  captures: readonly FieldCaptureRow[]
): readonly CaptureParityChannel[] {
  return captures.map((capture) => ({
    channel_id: capture.channel.channel_id,
    status: capture.channel.status,
    observation_keys: capture.channel.observations.map((row) => row.candidate_key)
  }));
}

export function createCaptureParityView(
  view: CaptureParityView
): Readonly<CaptureParityView> {
  return Object.freeze({
    question_id: view.question_id,
    channels: Object.freeze(view.channels.map((channel) => Object.freeze({
      channel_id: channel.channel_id,
      status: channel.status,
      observation_keys: Object.freeze([...channel.observation_keys])
    }))),
    geometry: Object.freeze({
      answer_shape_plan: view.geometry.answer_shape_plan,
      probes: view.geometry.probes
    }),
    membership: Object.freeze(view.membership.map((member) => Object.freeze({
      object_kind: member.object_kind,
      object_id: member.object_id
    }))),
    assessment_path: view.assessment_path
  });
}

export function extractCaptureParityView(
  questionId: string,
  result: RecallResult
): Readonly<CaptureParityView> {
  const diagnostics = result.diagnostics;
  if (diagnostics === undefined) {
    throw new Error(`capture parity diagnostics missing (question_id=${questionId})`);
  }
  return createCaptureParityView({
    question_id: questionId,
    channels: mapCaptureParityChannels(
      requireRetrievalFieldCaptures(questionId, diagnostics.retrieval_field_captures)
    ),
    geometry: {
      answer_shape_plan: diagnostics.answer_shape_plan ?? null,
      probes: diagnostics.query_probes
    },
    membership: result.candidates.map((candidate) => ({
      object_kind: candidate.object_kind,
      object_id: candidate.object_id
    })),
    assessment_path: diagnostics.packet_plan_trace?.assessment_path ?? null
  });
}

export function assertCaptureParityWindow(
  windowLength: number,
  sidecarQuestionCount: number
): void {
  if (!Number.isInteger(sidecarQuestionCount) || sidecarQuestionCount <= 0) {
    throw new Error("capture parity sidecar_question_count must be a positive integer");
  }
  if (windowLength === 0) {
    throw new Error("capture parity window is empty");
  }
  if (windowLength !== sidecarQuestionCount) {
    throw new Error(
      `capture parity window_length=${windowLength} does not match sidecar_question_count=${sidecarQuestionCount}`
    );
  }
}

export function compareCaptureParity(
  captureOff: readonly CaptureParityView[],
  captureOn: readonly CaptureParityView[],
  sidecarQuestionCount: number
): Readonly<CaptureParityReport> {
  if (captureOff.length === 0 || captureOn.length === 0) {
    throw new Error("capture parity window is empty");
  }
  if (captureOff.length !== captureOn.length) {
    throw new Error(
      `capture parity population size differs: off=${captureOff.length} on=${captureOn.length}`
    );
  }
  assertCaptureParityWindow(captureOff.length, sidecarQuestionCount);
  const questions = captureOff.map((off, index) => compareAlignedQuestion(off, captureOn[index], index));
  return buildReport(questions, sidecarQuestionCount);
}

function compareAlignedQuestion(
  off: CaptureParityView,
  on: CaptureParityView | undefined,
  index: number
): CaptureParityQuestionVerdict {
  if (on === undefined || off.question_id !== on.question_id) {
    throw new Error(
      `capture parity question identity differs at ${index}: ` +
        `off=${off.question_id} on=${on?.question_id ?? "<missing>"}`
    );
  }
  return compareQuestion(off, on);
}

function compareQuestion(
  off: CaptureParityView,
  on: CaptureParityView
): CaptureParityQuestionVerdict {
  const masks: CaptureParityMask[] = [];
  if (off.assessment_path !== on.assessment_path) masks.push("hydrate_vs_compute");
  const dropEmbedding = embeddingObserved(off.channels) !== embeddingObserved(on.channels);
  if (dropEmbedding) masks.push("embedding_observation");
  const offChannels = maskedChannels(off.channels, dropEmbedding);
  const onChannels = maskedChannels(on.channels, dropEmbedding);
  const channels = axisEqual(offChannels, onChannels);
  const geometry = axisEqual(off.geometry, on.geometry);
  const membership = axisEqual(off.membership, on.membership);
  return Object.freeze({
    question_id: off.question_id,
    channels: channels ? "pass" : "fail",
    geometry: geometry ? "pass" : "fail",
    membership: membership ? "pass" : "fail",
    exercised_masks: Object.freeze([...new Set(masks)]),
    digests: Object.freeze({ off: axisDigests(off), on: axisDigests(on) }),
    difference: firstAxisDifference(off.question_id, [
      ["channels", channels, offChannels, onChannels],
      ["geometry", geometry, off.geometry, on.geometry],
      ["membership", membership, off.membership, on.membership]
    ])
  });
}

function axisDigests(view: CaptureParityView): CaptureParityAxisDigests {
  return Object.freeze({
    channels: digestRecallFieldIdentity(view.channels),
    geometry: digestRecallFieldIdentity(view.geometry),
    membership: digestRecallFieldIdentity(view.membership)
  });
}

function firstAxisDifference(
  questionId: string,
  axes: readonly (readonly [CaptureParityAxis, boolean, unknown, unknown])[]
): CaptureParityDifference | null {
  for (const [axis, equal, expected, actual] of axes) {
    if (equal) continue;
    return Object.freeze({
      question_id: questionId,
      axis,
      message: `capture parity ${axis} differs (question_id=${questionId}): ` +
        `expected ${stableStringify(expected)} actual ${stableStringify(actual)}`
    });
  }
  return null;
}

function buildReport(
  questions: readonly CaptureParityQuestionVerdict[],
  sidecarQuestionCount: number
): Readonly<CaptureParityReport> {
  const first = questions.find((row) => row.difference !== null)?.difference ?? null;
  const masks = [...new Set(questions.flatMap((row) => row.exercised_masks))];
  return Object.freeze({
    schema_version: 2 as const,
    geometry_basis: CAPTURE_PARITY_GEOMETRY_BASIS,
    parity: first === null,
    question_count: questions.length,
    sidecar_question_count: sidecarQuestionCount,
    window_length: questions.length,
    first_difference: first,
    summary: Object.freeze({
      channels: questions.every((row) => row.channels === "pass") ? "pass" : "fail",
      geometry: questions.every((row) => row.geometry === "pass") ? "pass" : "fail",
      membership: questions.every((row) => row.membership === "pass") ? "pass" : "fail",
      exercised_masks: Object.freeze(masks)
    }),
    questions: Object.freeze(questions)
  });
}

function embeddingObserved(channels: readonly CaptureParityChannel[]): boolean {
  return channels.some((channel) =>
    EMBEDDING_CHANNEL_IDS.has(channel.channel_id) &&
    channel.status !== "unavailable" &&
    channel.status !== "ineligible"
  );
}

function maskedChannels(
  channels: readonly CaptureParityChannel[],
  dropEmbedding: boolean
): readonly CaptureParityChannel[] {
  if (!dropEmbedding) return channels;
  return channels.filter((channel) => !EMBEDDING_CHANNEL_IDS.has(channel.channel_id));
}

function axisEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
