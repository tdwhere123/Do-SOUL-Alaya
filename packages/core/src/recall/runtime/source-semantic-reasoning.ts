import {
  canonicalJson, interpretationNodeIdentity,
  SourceSemanticInterpretationSchema, SourceSemanticPublishedInterpretationSchema,
  SourceSemanticReasoningRequestSchema, SourceSemanticReasoningResultSchema,
  type QueryProgram, type SourceEvidenceTarget, type SourceSemanticInterpretation,
  type SourceSemanticQuery, type SourceSemanticQueryAlternative, type SourceSemanticQueryFrame,
  type SourceSemanticReasoningRequest, type SourceSemanticReasoningResult
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { compileConditionalFieldQuery } from "../conditional-field/query/compile-query.js";
import { defaultView } from "../conditional-field/query/query-admission.js";
import { admitSourceSemanticAlignment } from "../conditional-field/query/source-semantic-alignment-admission.js";
import { observeField } from "./conditional-field-observe.js";
import { projectAcceptingIndex } from "../conditional-field/index/project-accepting-index.js";
import {
  compileSourceSemanticPremises, SourceSemanticPreparationLimit, sourceSemanticReaders,
  sourceSemanticRelationKey
} from "./source-semantic-premises.js";

const GUARD = {
  schema_version: 1 as const, kind: "query_predicate" as const, verdict: "unresolved" as const, time_scope: "none" as const
};
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};

export type ReasonSourceSemanticInterpretationInput = Readonly<{
  request?: SourceSemanticReasoningRequest;
  h: unknown;
  q?: unknown;
  a?: unknown;
  original_query?: string;
  workspaceId: string;
  scope: string;
  authorizedScopes: readonly string[] | null;
  asOf: string;
  sourceValidity?: Readonly<{ valid_from: string | null; valid_to: string | null }>;
  source_target?: SourceEvidenceTarget;
}>;

/** Compiles admitted C = (H, Q, A) onto the existing max/min engine. Live v2 packet reasoning is unchanged. */
export function reasonSourceSemanticInterpretation(
  input: ReasonSourceSemanticInterpretationInput
): SourceSemanticReasoningResult {
  const original = input.request?.original_query ?? input.original_query;
  const missing = missingPreparation(input.q, input.a);
  if (missing !== undefined || original === undefined) {
    return finish({
      outcome: { status: "preparation_required", missing: missing ?? "q_and_a" },
      consumed_leaves: []
    });
  }
  const published = SourceSemanticPublishedInterpretationSchema.safeParse(input.h);
  const body = SourceSemanticInterpretationSchema.safeParse(input.h);
  const interpretation = published.success ? published.data.interpretation : body.success ? body.data : undefined;
  if (interpretation === undefined) {
    return finish({ outcome: { status: "invalid", reason: "malformed_interpretation" }, consumed_leaves: [] });
  }
  const admission = admitSourceSemanticAlignment({
    alignment: input.a, h: interpretation, q: input.q, original_query: original
  });
  if (admission.kind === "absent") {
    return finish({ outcome: { status: "preparation_required", missing: "a" }, consumed_leaves: [] });
  }
  if (admission.kind !== "admitted") {
    return finish({
      outcome: { status: "invalid", reason: admission.kind === "unsupported" ? "unsupported_producer" : "malformed_alignment" },
      consumed_leaves: []
    });
  }
  const request = input.request === undefined ? undefined : SourceSemanticReasoningRequestSchema.parse(input.request);
  if (request !== undefined && (request.h_id !== admission.interpretation_id ||
      request.q_id !== admission.query_id || request.a_id !== admission.alignment_id)) {
    return finish({ outcome: { status: "invalid", reason: "identity_mismatch" }, consumed_leaves: [] });
  }
  if (input.authorizedScopes !== null && !input.authorizedScopes.includes(input.scope)) {
    return finish({ outcome: { status: "invalid", reason: "unauthorized_scope" }, consumed_leaves: [] });
  }
  const sourceTarget = input.source_target ?? (published.success ? published.data.source_target : undefined) ?? {
    kind: "source_evidence" as const,
    workspace_id: input.workspaceId,
    root_kind: "source_record" as const,
    root_id: interpretation.source.source_id,
    source_version: interpretation.source.source_version,
    content_digest: interpretation.source.content_digest,
    evidence_object_id: null
  };
  const budget = request?.budget ?? BUDGET;
  const qualified = {
    c_id: admission.context_id, h_id: admission.interpretation_id,
    q_id: admission.query_id, a_id: admission.alignment_id
  };
  let population;
  try {
    population = compileSourceSemanticPremises({
      interpretation: admission.interpretation, alignment: admission.alignment,
      context_id: admission.context_id, interpretation_id: admission.interpretation_id,
      scope: input.scope, source_target: sourceTarget, budget, sourceValidity: input.sourceValidity
    });
  } catch (error) {
    if (error instanceof SourceSemanticPreparationLimit) {
      return finish({ ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] });
    }
    throw error;
  }
  const seeds = [...admission.interpretation.entry_roots].sort().map((id) => {
    const coordinate = population.coordinates.get(id);
    if (coordinate === undefined) throw new CoreError("VALIDATION", "entry root is not a node in this interpretation");
    return interpretationNodeIdentity(coordinate);
  });
  const snapshot = `sha256:${fieldContractSha256(canonicalJson({
    c: admission.context_id, scopes: input.authorizedScopes, as_of: input.asOf
  }))}`;
  const remaining = {
    ...budget,
    work_units: budget.work_units - population.work,
    memory_bytes: budget.memory_bytes - population.bytes
  };
  const program = compileSourceSemanticQueryProgram(admission.query);
  const query = compileConditionalFieldQuery({
    source: "typed", snapshot_id: snapshot, budget: remaining,
    query_id: `sha256:${fieldContractSha256(canonicalJson({ c: admission.context_id, query: original }))}`,
    program, interpretation_clock: input.asOf,
    hypotheses: [{ schema_version: 1, hypothesis_id: admission.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1,
      supported_result_kinds: ["source_evidence", "memory_entry"] },
    authorized_scopes: input.authorizedScopes
  });
  const state = observeField(query, {
    workspace_id: input.workspaceId, query_text: original, as_of: input.asOf, budget: remaining,
    readers: sourceSemanticReaders(population, seeds), authorized_scopes: input.authorizedScopes
  });
  if (state.binding.kind !== "bound") {
    return finish({ ...qualified, outcome: { status: "resource_exhausted" }, consumed_leaves: [] });
  }
  const index = projectAcceptingIndex({
    snapshot: state.binding.snapshot, view: query.view, query_id: query.query_id, snapshot_id: snapshot,
    result_version: "source-interpretation-reasoning-v2",
    budget: { ...remaining, work_units: state.remaining_exploration, memory_bytes: state.remaining_memory_bytes },
    binding_contexts: state.binding_contexts,
    observer: { outcome: { schema_version: 1, status: state.closure.observation }, open_regions: state.residuals },
    interpretation_status: query.status, resume_cursors: state.resume_cursors,
    remaining_reserve: state.remaining_exploration + state.remaining_reserve,
    resource_work: state.memory_exhausted || state.remaining_work.length > 0 ? "open" : "complete",
    transition_derivations: state.transition_derivations,
    grounding_progress: state.grounding_progress, grounding_transitions: [...state.transitions],
    grounding_seeds: [...state.seeds], grounding_derivations: [...state.derivations],
    derivations: [...state.derivations], projection_facets: [...state.facets],
    remaining_memory_bytes: state.remaining_memory_bytes
  });
  if (index.entries.some((entry) => entry.interpretation_node !== undefined &&
      (entry.interpretation_node.packet_id !== admission.interpretation_id ||
        entry.hypothesis_id !== admission.context_id))) {
    throw new CoreError("OBLIGATION_VIOLATION", "conditional result escaped its admitted evaluation context");
  }
  const consumed = new Set((index.explanations ?? []).flatMap((row) => row.observation_ids));
  const seen = new Set<string>();
  const leaves = [...consumed].flatMap((id) => {
    const leaf = population.origins.get(id);
    if (leaf === undefined) return [];
    const key = JSON.stringify(leaf);
    if (seen.has(key)) return [];
    seen.add(key);
    return [leaf];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const outcome = state.memory_exhausted
    ? { status: "resource_exhausted" as const }
    : { status: "interpreted" as const, gaps: admission.interpretation.gaps };
  return finish({
    ...qualified, outcome, consumed_leaves: leaves
  }, request?.output_byte_limit);
}

export function compileSourceSemanticQueryProgram(query: SourceSemanticQuery): QueryProgram {
  const options = query.alternatives.map((alternative, index) => compileAlternative(alternative, index));
  return options.length === 1 ? options[0]! : { schema_version: 1, kind: "alternative", options };
}

function missingPreparation(q: unknown, a: unknown): "q" | "a" | "q_and_a" | undefined {
  if (q === undefined && a === undefined) return "q_and_a";
  if (q === undefined) return "q";
  if (a === undefined) return "a";
  return undefined;
}

function finish(
  result: Omit<SourceSemanticReasoningResult, "contract" | "semantic_status" | "conclusion_scope" | "world_claim">,
  outputLimit = 1_000_000
): SourceSemanticReasoningResult {
  const checked = SourceSemanticReasoningResultSchema.parse({
    contract: "source-interpretation-reasoning-v2",
    semantic_status: "unreviewed",
    conclusion_scope: "conditional_on_interpretation",
    world_claim: "unknown",
    ...result
  });
  if (Buffer.byteLength(JSON.stringify(checked)) <= outputLimit) return checked;
  const limited = SourceSemanticReasoningResultSchema.parse({
    ...checked, outcome: { status: "truncated" }, consumed_leaves: []
  });
  if (Buffer.byteLength(JSON.stringify(limited)) > outputLimit) {
    throw new CoreError("VALIDATION", "output budget cannot retain mandatory interpretation qualifier");
  }
  return limited;
}

function rel(kind: string, from: string, to: string): QueryProgram {
  return {
    schema_version: 1, kind: "relation", relation_kind: kind, source_variable: from, target_variable: to,
    guard: GUARD, facet_mode: "same_path", threshold_milligrades: 0
  };
}

function seq(steps: QueryProgram[]): QueryProgram {
  if (steps.length === 0) return { schema_version: 1, kind: "empty" };
  if (steps.length === 1) return steps[0]!;
  return { schema_version: 1, kind: "sequence", steps };
}

type VariableEnd = Readonly<{ frame: string; via: "self" | "role"; role?: string }>;
type TreeLink = Readonly<{
  child: string;
  kind: "variable" | "incidence";
  variable?: string;
  parentRole?: string;
  childRole?: string;
  role?: string;
}>;

function compileAlternative(alternative: SourceSemanticQueryAlternative, alt: number): QueryProgram {
  const frames = new Map(alternative.frames.map((row) => [row.id, row]));
  const nested = nestedFrameIds(alternative);
  const root = alternative.frames.find((row) => !nested.has(row.id)) ?? alternative.frames[0]!;
  const children = structuralChildren(alternative, root.id);
  return walkFrame(root.id, true, frames, alternative, alt, children);
}

function nestedFrameIds(alternative: SourceSemanticQueryAlternative): Set<string> {
  return new Set(
    alternative.context_obligations.flatMap((row) => row.incidence === undefined ? [] : [row.frame])
  );
}

function walkFrame(
  id: string,
  isRoot: boolean,
  frames: Map<string, SourceSemanticQueryFrame>,
  alternative: SourceSemanticQueryAlternative,
  alt: number,
  children: ReadonlyMap<string, readonly TreeLink[]>
): QueryProgram {
  const frame = frames.get(id)!;
  const prefix: QueryProgram[] = [];
  if (isRoot) {
    prefix.push(rel(sourceSemanticRelationKey("candidate_route"), frame.variable, frame.variable));
  }
  prefix.push(...coreObligations(frame, alternative, alt));
  const links = children.get(id) ?? [];
  const hopRoles = new Set(links.flatMap((link) => link.parentRole === undefined ? [] : [link.parentRole]));
  const branches: QueryProgram[] = [];
  for (const role of frame.role_requirements) {
    if (!hopRoles.has(role.id)) branches.push(seq(oneRole(frame, role.id, alt)));
  }
  for (const link of links) {
    branches.push(seq([...treeHop(frame, frames.get(link.child)!, link, alt),
      ...flatten(walkFrame(link.child, false, frames, alternative, alt, children))]));
  }
  for (const obligation of alternative.context_obligations) {
    if (obligation.incidence === undefined || obligation.incidence.other_frame !== id) continue;
    if (links.some((link) => link.child === obligation.frame)) continue;
    const nested = frames.get(obligation.frame);
    if (nested === undefined) continue;
    const link: TreeLink = {
      child: obligation.frame, kind: "incidence", role: obligation.incidence.role ?? "content"
    };
    branches.push(seq([...treeHop(frame, nested, link, alt),
      ...flatten(walkFrame(obligation.frame, false, frames, alternative, alt, children))]));
  }
  if (branches.length <= 1) return seq([...prefix, ...flatten(branches[0] ?? { schema_version: 1, kind: "empty" })]);
  return {
    schema_version: 1, kind: "hyperedge", join: "and",
    premises: branches.map((branch) => seq([...prefix, ...flatten(branch)]))
  };
}

function treeHop(
  frame: SourceSemanticQueryFrame,
  child: SourceSemanticQueryFrame,
  link: TreeLink,
  alt: number
): QueryProgram[] {
  if (link.kind === "incidence") {
    return [rel(sourceSemanticRelationKey("h_content", link.role ?? "content"), frame.variable, child.variable)];
  }
  const steps: QueryProgram[] = [];
  if (link.parentRole !== undefined) steps.push(...oneRole(frame, link.parentRole, alt));
  if (link.childRole !== undefined && link.variable !== undefined) {
    steps.push(rel(
      sourceSemanticRelationKey("h_binding_inv", alt, child.id, link.childRole), link.variable, child.variable
    ));
  }
  return steps;
}

function flatten(program: QueryProgram): QueryProgram[] {
  return program.kind === "sequence" ? [...program.steps] : program.kind === "empty" ? [] : [program];
}

function structuralChildren(alternative: SourceSemanticQueryAlternative, root: string): Map<string, TreeLink[]> {
  const nested = nestedFrameIds(alternative);
  const children = new Map<string, TreeLink[]>();
  const placed = new Set([root]);
  const attach = (parent: string, link: TreeLink) => {
    const list = children.get(parent) ?? [];
    list.push(link);
    children.set(parent, list);
    placed.add(link.child);
  };
  let grew = true;
  while (grew) {
    grew = false;
    const incidence = alternative.context_obligations.filter((row) =>
      row.incidence !== undefined && placed.has(row.incidence.other_frame) && !placed.has(row.frame)
    ).sort((left, right) => left.frame.localeCompare(right.frame));
    if (incidence[0]?.incidence !== undefined) {
      attach(incidence[0].incidence.other_frame, {
        child: incidence[0].frame, kind: "incidence", role: incidence[0].incidence.role ?? "content"
      });
      grew = true;
      continue;
    }
    const candidates: { parent: string; link: TreeLink }[] = [];
    for (const [variable, ends] of variableOwners(alternative)) {
      for (let i = 0; i < ends.length; i += 1) {
        for (let j = i + 1; j < ends.length; j += 1) {
          const left = ends[i]!, right = ends[j]!;
          if (left.frame === right.frame) continue;
          const tryAttach = (from: VariableEnd, to: VariableEnd) => {
            if (!placed.has(from.frame) || placed.has(to.frame) || nested.has(to.frame)) return;
            candidates.push({
              parent: from.frame,
              link: {
                child: to.frame, kind: "variable", variable,
                parentRole: from.via === "role" ? from.role : undefined,
                childRole: to.via === "role" ? to.role : undefined
              }
            });
          };
          tryAttach(left, right);
          tryAttach(right, left);
        }
      }
    }
    candidates.sort((left, right) =>
      left.link.child.localeCompare(right.link.child) || left.parent.localeCompare(right.parent));
    if (candidates[0] !== undefined) {
      attach(candidates[0].parent, candidates[0].link);
      grew = true;
    }
  }
  for (const list of children.values()) list.sort((left, right) => left.child.localeCompare(right.child));
  return children;
}

function variableOwners(alternative: SourceSemanticQueryAlternative): Map<string, VariableEnd[]> {
  const owners = new Map<string, VariableEnd[]>();
  const record = (variable: string, end: VariableEnd) => {
    const list = owners.get(variable) ?? [];
    list.push(end);
    owners.set(variable, list);
  };
  for (const frame of alternative.frames) {
    record(frame.variable, { frame: frame.id, via: "self" });
    for (const role of frame.role_requirements) {
      record(role.target_variable, { frame: frame.id, via: "role", role: role.id });
    }
  }
  return owners;
}

function coreObligations(
  frame: SourceSemanticQueryFrame,
  alternative: SourceSemanticQueryAlternative,
  alt: number
): QueryProgram[] {
  const steps: QueryProgram[] = [
    rel(sourceSemanticRelationKey("a_predicate", alt, frame.id), frame.variable, frame.variable),
    rel(sourceSemanticRelationKey("h_presence"), frame.variable, frame.variable)
  ];
  if (frame.source_act !== undefined) {
    steps.push(rel(sourceSemanticRelationKey("source_act", frame.source_act), frame.variable, frame.variable));
  }
  for (const obligation of alternative.context_obligations) {
    if (obligation.frame !== frame.id) continue;
    if (obligation.kind === "asserted_at_source") {
      steps.push(rel(sourceSemanticRelationKey("h_assertion_permission"), frame.variable, frame.variable));
    } else if (obligation.kind === "explicit_embedded_structure") {
      steps.push(rel(sourceSemanticRelationKey("h_embedded"), frame.variable, frame.variable));
    } else {
      steps.push(rel(sourceSemanticRelationKey("open_context"), frame.variable, frame.variable));
    }
  }
  return steps;
}

function oneRole(frame: SourceSemanticQueryFrame, roleId: string, alt: number): QueryProgram[] {
  const role = frame.role_requirements.find((row) => row.id === roleId);
  if (role === undefined) return [];
  return [
    rel(sourceSemanticRelationKey("a_slot", alt, frame.id, role.id), frame.variable, frame.variable),
    rel(sourceSemanticRelationKey("h_binding", alt, frame.id, role.id), frame.variable, role.target_variable)
  ];
}
