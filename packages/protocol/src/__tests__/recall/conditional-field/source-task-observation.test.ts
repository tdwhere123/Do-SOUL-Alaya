import { expect, it } from "vitest";
import {
  SOURCE_TASK_OBSERVATION_PRODUCER_ID,
  SourceTaskObservationDraftSchema,
  SourceTaskObservationFormationInputSchema,
  SourceTaskObservationProposalSchema
} from "../../../recall/conditional-field/index.js";
import { QualifiedTaskObservationSchema } from "../../../recall/conditional-field/source-task-observation.js";
import { HostSourceDependenciesSchema, HostSourceDependencySchema } from "../../../conversation/host-source-dependency.js";

const digest = `sha256:${"a".repeat(64)}`;
const span = { start_byte: 0, end_byte: 18, text: "tried tea Thursday" };
const source = { kind: "source_evidence" as const, workspace_id: "workspace", root_kind: "source_record" as const,
  root_id: "source-root", source_version: "1", content_digest: digest, evidence_object_id: null };
const observation = {
  source, source_observed_at: "2026-09-08T00:00:00.000Z", source_excerpt: span, query_excerpt: span,
  utterance: { kind: "reported_event" as const, description: "The speaker tried tea." },
  task_correspondence: { status: "possible" as const, role: "requested_event" as const, component: "drink" },
  event_time: { status: "unavailable" as const }
};

it("keeps source-local observations distinct from failed proposals and refuses a non-unique event expression", () => {
  expect(SOURCE_TASK_OBSERVATION_PRODUCER_ID).toBe("alaya.query.source-task-observation.v1");
  const ready = SourceTaskObservationProposalSchema.parse({
    status: "ready", interpretation_clock: "2026-09-18T00:00:00.000Z", observations: [observation]
  });
  expect(ready.status).toBe("ready");
  expect(SourceTaskObservationProposalSchema.parse({ status: "failed", reason: "provider refused" }).status)
    .toBe("failed");
  expect(SourceTaskObservationProposalSchema.parse({ status: "unavailable", reason: "no admitted source" }).status)
    .toBe("unavailable");
  expect(SourceTaskObservationProposalSchema.safeParse({
    status: "ready", interpretation_clock: "2026-09-18T00:00:00.000Z",
    observations: [{ ...observation, source: { ...source, root_kind: "evidence_capsule" } }]
  }).success).toBe(false);
  const interpreted = { status: "interpreted" as const, expression: "Thursday",
    anchor: "source_observation_clock" as const, interval: { start: "2026-09-03", end: "2026-09-03" } };
  expect(SourceTaskObservationProposalSchema.parse({
    status: "partial", interpretation_clock: "2026-09-18T00:00:00.000Z",
    observations: [{ ...observation, event_time: interpreted }]
  }).status).toBe("partial");
  expect(SourceTaskObservationProposalSchema.safeParse({
    status: "ready", interpretation_clock: "2026-09-18T00:00:00.000Z",
    observations: [{ ...observation, event_time: interpreted,
      source_excerpt: { start_byte: 0, end_byte: 20, text: "Thursday or Thursday" }, source_observed_at: null }]
  }).success).toBe(false);
});

it("parses a wire draft and a qualified hypothesis without treating overlap as event identity", () => {
  expect(SourceTaskObservationDraftSchema.parse({
    observations: [{ source_ref: "source1", source_excerpt: span.text, query_excerpt: span.text,
      association_status: "missing", association_ref: null, temporal_operand_status: "missing",
      temporal_operand_ref: null, utterance_kind: "reported_event", description: "The speaker tried tea.",
      task_correspondence: "possible", task_role: "requested_event", task_component: "drink",
      time_status: "unavailable", time_expression: null, time_anchor: null, time_start: null, time_end: null }]
  }).observations).toHaveLength(1);
  expect(QualifiedTaskObservationSchema.parse({
    semantic_status: "unreviewed", world_claim: "unknown", observation,
    question_time: { interpretation_clock: "2026-09-18T00:00:00.000Z",
      intervals: [{ start: "2026-09-17", end: "2026-09-17" }] },
    temporal_relation: "hypothesized_overlap"
  }).temporal_relation).toBe("hypothesized_overlap");
  expect(SourceTaskObservationFormationInputSchema.parse({
    query: "What drink?", interpretation_clock: "2026-09-18T00:00:00.000Z",
    question_time: { interpretation_clock: "2026-09-18T00:00:00.000Z", intervals: [] },
    sources: [{ source_ref: "source1", target: source, source_observed_at: observation.source_observed_at,
      body: span.text }]
  }).sources).toHaveLength(1);
  expect(HostSourceDependenciesSchema.parse([])).toEqual([]);
  expect(HostSourceDependencySchema.parse({
    source_id: "source", root_id: "root", source_version: "1", content_digest: digest, occurrence_id: "occ-1"
  }).source_id).toBe("source");
});
