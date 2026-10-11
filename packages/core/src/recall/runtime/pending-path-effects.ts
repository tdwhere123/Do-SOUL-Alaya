import { productEndpointId, type ObserverPage } from "@do-soul/alaya-protocol";
import { applyObserverPage, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { createAdjacencyEffectCursor } from "../conditional-field/engine/path-composition-adjacency.js";
import type { PathEffectPreparation } from "../conditional-field/engine/path-effect-cursor.js";
import { pairKey } from "../conditional-field/engine/path-routing.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";

const PREPARATION_BASE_BYTES = 128;

function preparationBytes(effectCount: number): number {
  return PREPARATION_BASE_BYTES + 8 * effectCount;
}

export function resumePathEffects(state: FieldEngineState): FieldEngineState {
  while (state.pending_path_effects !== undefined) {
    const prior = state;
    state = advancePathEffects(state);
    if (state.memory_exhausted || state.retention_rejected !== undefined
      || state.remaining_exploration === prior.remaining_exploration) break;
  }
  return state;
}

function advancePathEffects(state: FieldEngineState): FieldEngineState {
  state = beginPathEffectPreparation(state);
  if (state.memory_exhausted || state.pending_path_effects?.preparation === undefined) return state;
  state = preparePathEffects(state);
  if (state.memory_exhausted || state.pending_path_effects?.preparation === undefined
    || state.pending_path_effects.preparation.effect_index < state.pending_path_effects.preparation.effects.length) return state;
  return commitPathEffects(state);
}

function beginPathEffectPreparation(state: FieldEngineState): FieldEngineState {
  const pending = state.pending_path_effects;
  if (pending === undefined || pending.preparation !== undefined) return state;
  if (state.remaining_exploration === 0) return interrupted(state, false);
  const cursor = pending.cursor ?? createAdjacencyEffectCursor(pending.input.rows, pending.input.options,
    state.remaining_memory_bytes + pending.retained_bytes);
  if (cursor === undefined) return interrupted(state, true);
  const initialBytes = pending.cursor === undefined ? Math.max(0, cursor.initialRetainedBytes - pending.retained_bytes) : 0;
  const advanced = cursor.advance(pending.offset, Math.max(0, Math.floor(state.remaining_exploration / 2)),
    state.remaining_memory_bytes + pending.retained_bytes);
  const retained = { ...pending, cursor, retained_bytes: advanced.retained_bytes,
    completed_work: advanced.completed_work, progress_position: advanced.progress_position };
  const charged = { ...state, pending_path_effects: retained,
    remaining_exploration: state.remaining_exploration - advanced.work,
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0) + initialBytes + advanced.admitted_bytes,
    remaining_memory_bytes: state.remaining_memory_bytes - (advanced.retained_bytes - pending.retained_bytes) };
  if (advanced.status === "memory_exhausted") {
    return interrupted(charged, true);
  }
  const scratchBytes = preparationBytes(advanced.effects.length);
  if (charged.remaining_memory_bytes < scratchBytes) return interrupted(charged, true);
  const preparation: PathEffectPreparation = {
    effects: advanced.effects, next_offset: advanced.offset, status: advanced.status,
    effect_index: 0, stage: "start", facet_scan_index: 0,
    facet_resume_offset: pending.facet_resume_offset ?? pending.input.options.liveStates.length,
    pair_demands: state.pair_demands, pair_bytes: 0,
    source_demands: state.source_fact_demands, source_pending: state.source_fact_pending_count, source_bytes: 0,
    retained_bytes: scratchBytes
  };
  return { ...charged, pending_path_effects: { ...retained, preparation },
    admitted_allocation_bytes: charged.admitted_allocation_bytes + scratchBytes,
    remaining_memory_bytes: charged.remaining_memory_bytes - scratchBytes };
}

function preparePathEffects(state: FieldEngineState): FieldEngineState {
  const pending = state.pending_path_effects!;
  const preparation = pending.preparation!;
  const priorStates = pending.input.options.liveStates;
  let { effect_index: index, stage, facet_scan_index: scan, facet_resume_offset: facetOffset,
    pair_demands: pairs, pair_bytes: pairBytes, source_demands: sources,
    source_pending: sourcePending, source_bytes: sourceBytes } = preparation;
  let work = state.remaining_exploration;
  let memory = state.remaining_memory_bytes;
  let memoryBlocked = false;
  while (index < preparation.effects.length) {
    const effect = preparation.effects[index]!;
    if (stage === "start") {
      if (work === 0) break;
      work -= 1;
      stage = "pair";
    }
    if (stage === "pair") {
      const demand = effect.relation_demand;
      if (demand !== undefined) {
        if (work === 0) break;
        work -= 1;
        const key = pairKey(demand.subject, demand.predicate);
        if (!pairs.has(key)) {
          const bytes = 96 + Buffer.byteLength(key, "utf8");
          if (bytes > memory) { memoryBlocked = true; break; }
          pairs = pairs.with(key, true); pairBytes += bytes; memory -= bytes;
        }
      }
      stage = "source";
    }
    if (stage === "source") {
      const id = effect.source_fact_demand;
      if (id !== undefined) {
        if (work === 0) break;
        work -= 1;
        if (!state.source_facts?.has(id) && !sources.has(id)) {
          const bytes = 96 + Buffer.byteLength(id, "utf8");
          if (bytes > memory) { memoryBlocked = true; break; }
          sources = sources.with(id, "pending"); sourcePending += 1; sourceBytes += bytes; memory -= bytes;
        }
      }
      stage = "facet";
    }
    // Admission keeps the first path_id, so a retained facet cannot widen the frontier.
    if (stage === "facet" && effect.facet !== undefined && !state.retained_index?.facets.has(effect.facet.path_id)) {
      const target = effect.transition?.to ?? effect.hyperedge?.to;
      if (target === undefined) facetOffset = 0;
      else {
        const targetId = productStateNodeId(target);
        while (scan < facetOffset && work > 0) {
          const position = scan;
          scan += 1; work -= 1;
          if (productStateNodeId(priorStates.at(position)!) === targetId) facetOffset = position;
        }
        if (scan < facetOffset && work === 0) break;
      }
    }
    index += 1; stage = "start"; scan = 0;
  }
  const next: PathEffectPreparation = { ...preparation, effect_index: index, stage,
    facet_scan_index: scan, facet_resume_offset: facetOffset, pair_demands: pairs,
    pair_bytes: pairBytes, source_demands: sources, source_pending: sourcePending, source_bytes: sourceBytes,
    retained_bytes: preparationBytes(preparation.effects.length) + pairBytes + sourceBytes };
  const charged = { ...state, pending_path_effects: { ...pending, preparation: next },
    admitted_allocation_bytes: (state.admitted_allocation_bytes ?? 0)
      + (state.remaining_memory_bytes - memory),
    remaining_exploration: work, remaining_memory_bytes: memory };
  return index < preparation.effects.length ? interrupted(charged, memoryBlocked) : charged;
}

function commitPathEffects(state: FieldEngineState): FieldEngineState {
  const pending = state.pending_path_effects!;
  const preparation = pending.preparation!;
  const { effects } = preparation;
  const prepared = { ...state, binding_contexts: pending.cursor?.bindingContexts?.snapshot() ?? state.binding_contexts };
  const page: ObserverPage = { ...pending.page,
    outcome: { ...pending.page.outcome, status: preparation.status === "complete" ? pending.page.outcome.status : "open" },
    open_regions: pending.page.open_regions.map((region) => region.region_id === pending.page.cursor.region_id
      && preparation.status !== "complete" ? { ...region, status: "open" } : region) };
  const applied = applyObserverPage(prepared, { page, effects });
  // A failed retention leaves the prior offset live; the cursor replays these effects.
  if (applied.retention_rejected !== undefined || applied.memory_exhausted) return interrupted(applied, applied.memory_exhausted);
  let subjects = applied.resume_subjects;
  for (const effect of effects) {
    const transition = effect.transition ?? effect.hyperedge;
    if (transition !== undefined) { subjects = subjects.with(productEndpointId(transition.from), true).with(productEndpointId(transition.to), true); }
    if (effect.discovery !== undefined) subjects = subjects.with(effect.discovery.subject_id, true);
  }
  const finished = preparation.status === "complete";
  const prior = pending.input.options;
  const newFacets = applied.facets.length !== (prior.facets?.length ?? 0);
  const guardsSeen = pending.guards_seen === true || effects.some((effect) => effect.unresolved_guard === true);
  // Only a complete pass can replace the prior guard result. A new source fact
  // replays retained rows, so an obsolete unknown can clear without hiding an
  // independent unknown encountered elsewhere in the same pass.
  const guards = finished ? (prior.liveStateOffset ?? 0) === 0 ? guardsSeen
    : state.observation_gaps?.guards === true || guardsSeen
    : state.observation_gaps?.guards === true;
  const measurements = state.observation_gaps?.measurements === true || effects.some((effect) => effect.missing_measurement === true);
  const missingRevision = effects.some((effect) => effect.missing_target_revision === true);
  const semanticDelta = finished && (applied.seen_identities.length > prior.liveStates.length || newFacets
    || applied.discoveries.length > (prior.discoveries?.length ?? 0) || missingRevision);
  const next = semanticDelta ? { input: { rows: pending.input.rows, options: { ...prior,
    bindingContexts: applied.binding_contexts,
    liveStates: applied.seen_identities, liveStateOffset: missingRevision ? 0 : preparation.facet_resume_offset,
    facets: applied.facets, discoveries: applied.discoveries } }, offset: 0, retained_bytes: 0,
    page: { ...page, observations: [], outcome: { ...page.outcome, status: "open" as const } } } : undefined;
  return { ...applied, resume_subjects: subjects,
    pair_demands: preparation.pair_demands, pair_demand_bytes: state.pair_demand_bytes + preparation.pair_bytes,
    source_fact_demands: preparation.source_demands, source_fact_demand_bytes: state.source_fact_demand_bytes + preparation.source_bytes,
    source_fact_pending_count: preparation.source_pending,
    binding_context_bytes: finished ? applied.binding_contexts?.bytes : applied.binding_context_bytes,
    ...(finished && !semanticDelta ? { path_effect_frontier: { identities: applied.seen_identities.length,
      facets: applied.facets, discoveries: applied.discoveries.length, sourceFacts: applied.source_facts } } : {}),
    observation_gaps: { guards, measurements },
    pending_path_effects: finished ? next : { ...pending, preparation: undefined, guards_seen: guardsSeen,
      facet_resume_offset: preparation.facet_resume_offset,
      offset: preparation.next_offset, page: { ...page, observations: [] } },
    remaining_memory_bytes: applied.remaining_memory_bytes + preparationBytes(effects.length) + (finished ? pending.retained_bytes
      - ((applied.binding_contexts?.bytes ?? 0) - (prior.bindingContexts?.bytes ?? 0)) : 0),
    ...(finished && !semanticDelta ? {} : { last_observer_status: "interrupted" as const,
      closure: { ...applied.closure, observation: "interrupted" as const, requested_index: "open" as const } }) };
}

function interrupted(state: FieldEngineState, memory: boolean): FieldEngineState {
  return { ...state, memory_exhausted: memory, last_observer_status: "interrupted",
    closure: { ...state.closure, observation: "interrupted", requested_index: "open" },
    residuals: state.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
}
