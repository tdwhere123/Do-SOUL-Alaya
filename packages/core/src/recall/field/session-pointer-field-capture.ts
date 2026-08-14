import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { CoarseRecallCandidate } from "../runtime/recall-service-types.js";
import { buildRecallCandidateDedupeKey } from
  "../runtime/recall-service-helpers.js";
import {
  createRecallFiniteFieldChannelCapture,
  type RecallFiniteFieldChannelCapture,
  type RecallRetrievalFieldChannelId
} from "./finite-field-capture.js";
import { digestRecallFieldIdentity } from "./field-identity.js";

export function buildSessionPointerFieldCaptures(params: Readonly<{
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
}>): readonly RecallFiniteFieldChannelCapture[] {
  return Object.freeze([
    captureChannel({
      channelId: "session_event_index",
      eligible: hasSessionProbes(params.queryProbes),
      candidates: params.candidates,
      plane: "session_surface_cohort",
      queryProbes: params.queryProbes
    }),
    captureChannel({
      channelId: "explicit_pointer",
      eligible: hasPointerProbes(params.queryProbes),
      candidates: params.candidates,
      plane: "object_probe",
      queryProbes: params.queryProbes
    })
  ]);
}

function captureChannel(params: Readonly<{
  readonly channelId: Extract<
    RecallRetrievalFieldChannelId,
    "session_event_index" | "explicit_pointer"
  >;
  readonly eligible: boolean;
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly plane: "session_surface_cohort" | "object_probe";
  readonly queryProbes: Readonly<RecallQueryProbes>;
}>): RecallFiniteFieldChannelCapture {
  const admitted = params.eligible
    ? params.candidates.filter((candidate) =>
      candidate.admissionPlanes?.includes(params.plane) === true)
    : [];
  return createRecallFiniteFieldChannelCapture({
    source_snapshot_digest: digestRecallFieldIdentity({
      producer: "session_pointer_field_capture_v1",
      channel_id: params.channelId,
      eligible: params.eligible,
      probe: probeIdentity(params.queryProbes),
      admitted: admitted.map((candidate) => candidate.entry.object_id).sort()
    }),
    channel: params.eligible
      ? completeChannel(params.channelId, admitted)
      : emptyChannel(params.channelId, "ineligible")
  });
}

function completeChannel(
  channelId: Extract<RecallRetrievalFieldChannelId, "session_event_index" | "explicit_pointer">,
  candidates: readonly Readonly<CoarseRecallCandidate>[]
) {
  const observations = Object.freeze(candidates.map((candidate, index) => Object.freeze({
    observation_id: `${channelId}:${candidate.entry.object_id}`,
    candidate_key: buildRecallCandidateDedupeKey(candidate),
    rank: index + 1
  })));
  return Object.freeze({
    channel_id: channelId,
    status: "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: 0
  });
}

function emptyChannel(
  channelId: Extract<RecallRetrievalFieldChannelId, "session_event_index" | "explicit_pointer">,
  status: "ineligible"
) {
  return Object.freeze({
    channel_id: channelId,
    status,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function hasSessionProbes(probes: Readonly<RecallQueryProbes>): boolean {
  return probes.surface_ids.length > 0 || probes.run_ids.length > 0;
}

function hasPointerProbes(probes: Readonly<RecallQueryProbes>): boolean {
  return probes.object_ids.length > 0 ||
    probes.evidence_refs.length > 0 ||
    probes.run_ids.length > 0 ||
    probes.surface_ids.length > 0 ||
    probes.file_paths.length > 0 ||
    probes.command_names.length > 0 ||
    probes.package_names.length > 0 ||
    probes.task_refs.length > 0 ||
    probes.dimensions.length > 0 ||
    probes.scope_classes.length > 0 ||
    probes.domain_tags.length > 0;
}

function probeIdentity(probes: Readonly<RecallQueryProbes>) {
  return Object.freeze({
    object_ids: probes.object_ids,
    evidence_refs: probes.evidence_refs,
    run_ids: probes.run_ids,
    surface_ids: probes.surface_ids,
    file_paths: probes.file_paths,
    command_names: probes.command_names,
    package_names: probes.package_names,
    task_refs: probes.task_refs,
    dimensions: probes.dimensions,
    scope_classes: probes.scope_classes,
    domain_tags: probes.domain_tags
  });
}
