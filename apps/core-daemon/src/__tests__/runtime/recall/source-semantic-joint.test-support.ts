import { sourceReferenceResolver, sourceSemanticQueryIdentity, sourceSemanticCorrespondenceIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION, type SourceReferenceCatalog, type SourceSemanticQuery,
  type SourceSemanticCorrespondence, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import type { SourceSemanticJointSelection } from "@do-soul/alaya-core/dist/recall/conditional-field/query/source-semantic-joint-witness.js";
import { type AccessFixtureSource } from "./source-semantic-access.test-support.js";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { assessmentForTestPairs } from "../../../../../bench-runner/src/__tests__/support/semantic-correspondence-assessment.js";

export const JOINT_QUESTION = "For M7, was its linked authorization completed before the inspection?";
export const REVIEW_TIME = "2026-09-17T10:00:00+00:00", APPROVAL_TIME = "2026-09-16T09:00:00+00:00";
const components = ["kind", "issuer", "project", "normalization", "value"] as const;
const values = { kind: "issue", issuer: "Forge", project: "Pilot", normalization: "exact", value: "TR-42" };
const variable = (slot: string) => slot === "value" ? "ticket" : slot;
const queryRole = (id: string, target = variable(id)) => ({ id, role_reading: id, target_variable: target,
  support: { kind: "query_text" as const, excerpt: JOINT_QUESTION } });
export function jointQuery(): SourceSemanticQuery {
  return { contract: "source-semantic-query-v4", original_query_digest: `sha256:${fieldContractSha256(JOINT_QUESTION)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [...["module", "ticket", "kind", "issuer", "project", "normalization", "reviewTime", "approvalTime"].map(id => ({
      id, sort: "entity" as const, ...(id === "module" ? { reference: { kind: "query_text" as const, excerpt: "M7" } } : {}) })),
      ...["bridge", "review", "approval"].map(id => ({ id, sort: "proposition" as const }))],
    alternatives: [{ frames: [
      { id: "qBridge", variable: "bridge", predicate_reading: "linked", role_requirements: [queryRole("module"), queryRole("value"), ...components.filter(k => k !== "value").map(k => queryRole(k))] },
      { id: "qReview", variable: "review", predicate_reading: "inspection", role_requirements: [queryRole("module"), queryRole("eventTime", "reviewTime")] },
      { id: "qApproval", variable: "approval", predicate_reading: "authorization", role_requirements: [...components.map(k => queryRole(k)), queryRole("eventTime", "approvalTime")] }
    ], context_obligations: ["qBridge", "qReview", "qApproval"].map(frame => ({ frame, kind: "asserted_at_source" as const })),
      answer_frames: [], evidence_inputs: [{ frames: ["qBridge", "qReview"] }, { frames: ["qApproval"] }] }],
    return_variables: [], requested_operation: { reading: "linked approval precedes inspection", support: { kind: "query_text", excerpt: JOINT_QUESTION } }, gaps: [] };
}

export function jointSource(id: string, seed: boolean, overrides: Partial<typeof values> & { time?: string; reviewModule?: string; modality?: "not" | "possible" } = {}): AccessFixtureSource {
  const v = { ...values, ...overrides }, time = overrides.time ?? (seed ? REVIEW_TIME : APPROVAL_TIME);
  const text = seed ? `M7 routes ${v.value} of kind ${v.kind} from issuer ${v.issuer} in project ${v.project} with normalization ${v.normalization}; ${overrides.reviewModule ?? "M7"} inspection occurred at source event time ${time}.`
    : `${id === "z" ? "" : "M7 memo: "}Issuer ${v.issuer} project ${v.project} kind ${v.kind} normalization ${v.normalization} ${v.value} was ${overrides.modality === "not" ? "not " : overrides.modality === "possible" ? "possibly " : ""}cleared at source event time ${time}.`;
  return { id, text, verbatim: true, authoredDraft: catalog => jointDraft(catalog, seed, v, time, overrides.reviewModule, overrides.modality) };
}
function jointDraft(catalog: SourceReferenceCatalog, seed: boolean, v: typeof values, time: string, reviewModule?: string, modality?: "not" | "possible") {
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const mentions: { id: string; assertion_id: number; source_ref: ReturnType<typeof resolver.referenceForSpan> }[] = [];
  const mention = (id: string, value: string, last = false) => {
    for (const assertion of catalog.assertions) {
      const text = assertion.segments.map(x => x.text).join("");
      const offset = last ? text.lastIndexOf(value) : text.indexOf(value);
      if (offset >= 0) { mentions.push({ id, assertion_id: assertion.assertion_id,
        source_ref: resolver.referenceForSpan(assertion.assertion_id, [offset, offset + value.length]) }); return; }
    }
    throw new Error(`joint source fixture is missing ${value}`);
  };
  for (const k of components) mention(`m${k}`, v[k]);
  mention("mTime", time);
  if (seed) { mention("mModule", "M7"); mention("mReviewModule", reviewModule ?? "M7", true); }
  const referents = [...components.map(k => ({ id: `r${k}`, referent_kind: k === "project" && v.project === "unknown" ? "unresolved" as const : "grouped" as const, mentions: [`m${k}`] })),
    { id: "rTime", referent_kind: "grouped" as const, mentions: ["mTime"] },
    ...(seed ? [{ id: "rModule", referent_kind: "grouped" as const, mentions: reviewModule === undefined ? ["mModule", "mReviewModule"] : ["mModule"] },
      ...(reviewModule === undefined ? [] : [{ id: "rReviewModule", referent_kind: "grouped" as const, mentions: ["mReviewModule"] }])] : [])];
  const frame = (id: string, predicate: string, slots: readonly string[]) => {
    mention(`m${id}`, predicate);
    const mid = (s: string) => s === "module" ? id === "fReview" ? "mReviewModule" : "mModule" : s === "eventTime" ? "mTime" : `m${s}`;
    return { id, assertion_ids: [...new Set(mentions.map(m => m.assertion_id))], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: predicate, mentions: [`m${id}`] },
      slots: slots.map(s => ({ id: s, role_reading: s, support: [{ kind: "lexical", mentions: [mid(s)] }] })),
      bindings: slots.map(s => ({ slot_id: s, target: { kind: "node", id: s === "module"
        ? id === "fReview" && reviewModule !== undefined ? "rReviewModule" : "rModule" : s === "eventTime" ? "rTime" : `r${s}` }, support: [] })) };
  };
  const frames = seed ? [frame("fBridge", "routes", ["module", ...components]), frame("fReview", "inspection", ["module", "eventTime"])]
    : [frame("fApproval", "cleared", [...components, "eventTime"])];
  if (modality !== undefined) mention("mModality", modality === "not" ? "not" : "possibly");
  return { contract: "source-interpretation-v4", mentions, referents,
    frames: modality === undefined ? frames : frames.map(f => ({ ...f, context_owner: { kind: "operator", operator_handle: "opModality" } })),
    operators: modality === undefined ? [] : [{ id: "opModality", operator: modality, content: "fApproval",
      assertion_ids: [...new Set(mentions.map(m => m.assertion_id))], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [{ kind: "lexical", mentions: ["mModality"] }] }],
    gaps: v.project !== "unknown" ? [] : [{ kind: "unresolved_referent", affected_ids: ["rproject"],
      support: [{ kind: "lexical", mentions: ["mproject"] }], description: "The source does not identify a project namespace." }] };
}

export function jointCorrespondence(id: string, seed: boolean, q = jointQuery()): SourceSemanticCorrespondence {
  const frames = seed ? [["qBridge", "fBridge"], ["qReview", "fReview"]] : [["qApproval", "fApproval"]];
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: id,
    query_semantics_id: sourceSemanticQueryIdentity(q, fieldContractSha256), producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1", contract_version: "source-semantic-correspondence-v3", correspondences: [
      ...(seed ? [{ relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: "module" },
        source_endpoint: { kind: "referent" as const, referent: "rModule" }, query_support: { kind: "query_text" as const, excerpt: "M7" },
        source_semantic_support: [{ kind: "lexical" as const, mentions: ["mModule"] }] }] : []),
      ...frames.flatMap(([qf, hf]) => [{ relation: "contextual_equivalence" as const,
        query_endpoint: { kind: "predicate" as const, alternative: 0, frame: qf! }, source_endpoint: { kind: "frame" as const, frame: hf! },
        query_support: { kind: "query_text" as const, excerpt: JOINT_QUESTION }, source_semantic_support: [{ kind: "lexical" as const, mentions: [`m${hf}`] }] },
        ...q.alternatives[0]!.frames.find(f => f.id === qf)!.role_requirements.map(r => ({ relation: "contextual_equivalence" as const,
          query_endpoint: { kind: "slot" as const, alternative: 0, frame: qf!, slot: r.id },
          source_endpoint: { kind: "slot" as const, frame: hf!, slot: r.id }, query_support: r.support,
          source_semantic_support: [{ kind: "lexical" as const, mentions: [r.id === "module" ? hf === "fReview" ? "mReviewModule" : "mModule"
            : r.id === "eventTime" ? "mTime" : `m${r.id}`] }] }))]) ] };
}

/** The discovered H's actual request catalog, not another H's frozen correspondence. */
export function jointCacheResponse(request: SourceSemanticCorrespondenceRequest): string {
  const pairs = request.catalog.query_endpoints.flatMap(q => {
    const source = request.catalog.source_endpoints.find(s => (q.kind === "predicate" && q.frame === "qApproval" && s.kind === "frame" && s.frame === "fApproval")
      || (q.kind === "slot" && q.frame === "qApproval" && s.kind === "slot" && s.frame === "fApproval" && q.slot === s.slot));
    if (source === undefined) return [];
    const slot = q.kind === "slot" ? q.slot : undefined;
    return [{ query: q.handle, source: source.handle, query_excerpt: JOINT_QUESTION,
      source_semantic_support: [{ kind: "lexical", mentions: [slot === undefined ? "mfApproval" : slot === "eventTime" ? "mTime" : `m${slot}`] }] }];
  });
  return JSON.stringify({ contract: "source-semantic-correspondence-response-v4", outcome: { status: "interpreted", gaps: [] },
    semantic_correspondence: { contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
      assessments: assessmentForTestPairs(request.catalog, JOINT_QUESTION, pairs) } });
}
export function jointSelection(seed: SourceSemanticCorrespondence, approval: SourceSemanticCorrespondence,
  seedTarget: SourceEvidenceTarget, approvalTarget: SourceEvidenceTarget): SourceSemanticJointSelection {
  const role = (slot: string, v = variable(slot)) => ({ variable: v, query_slot: slot, source_slot: slot });
  const key = { kind: role("kind"), issuer: role("issuer"), project: role("project"), normalization: role("normalization"), value: role("value") };
  return { contract: "private-two-h-chronology-v1", query_semantics_id: seed.query_semantics_id,
    seed: { interpretation_id: seed.source_interpretation_id, semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(seed, fieldContractSha256),
      source_target: seedTarget, alternative: 0, input: 0, bridge: { query_frame: "qBridge", source_frame: "fBridge" },
      review: { query_frame: "qReview", source_frame: "fReview" }, module: role("module"), review_module: role("module"), ticket: key,
      time: { ...role("eventTime", "reviewTime"), basis: "source_event_explicit_offset" } },
    approval: { interpretation_id: approval.source_interpretation_id, semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(approval, fieldContractSha256),
      source_target: approvalTarget, alternative: 0, input: 1, frame: { query_frame: "qApproval", source_frame: "fApproval" }, ticket: key,
      time: { ...role("eventTime", "approvalTime"), basis: "source_event_explicit_offset" } } };
}
