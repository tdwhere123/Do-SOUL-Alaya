import { productEndpointId, type ObserverPage } from "@do-soul/alaya-protocol";
import { applyObserverPage, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { createAdjacencyEffectCursor } from "../conditional-field/engine/path-composition-adjacency.js";
import { pairKey } from "../conditional-field/engine/path-routing.js";
import { productStateNodeId } from "../conditional-field/reference/bind-max-min.js";
import { SourceFactDemands } from "../conditional-field/engine/observation-frontier.js";

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
  const pending = state.pending_path_effects;
  if (pending === undefined) return state;
  const cursor = pending.cursor ?? createAdjacencyEffectCursor(pending.input.rows, pending.input.options,
    state.remaining_memory_bytes + pending.retained_bytes);
  if (cursor === undefined) return interrupted(state, true);
  const advanced = cursor.advance(pending.offset, Math.max(0, Math.floor(state.remaining_exploration / 2)),
    state.remaining_memory_bytes + pending.retained_bytes);
  const retained = { ...pending, cursor, retained_bytes: advanced.retained_bytes,
    completed_work: advanced.completed_work, progress_position: advanced.progress_position };
  if (advanced.status === "memory_exhausted") {
    return interrupted({ ...state, pending_path_effects: { ...retained, offset: pending.offset },
      remaining_exploration: Math.max(0, state.remaining_exploration - advanced.work),
      remaining_memory_bytes: Math.max(0, state.remaining_memory_bytes -
        (advanced.retained_bytes - pending.retained_bytes)) }, true);
  }
  const newPairs: string[] = [];
  const newSources: string[] = [];
  let demandBytes = 0;
  let pairBytes = 0;
  let sourceFactBytes = 0;
  let demandWork = 0;
  const priorStates = pending.input.options.liveStates;
  let facetResumeOffset = pending.facet_resume_offset ?? priorStates.length;
  for (const effect of advanced.effects) {
    if (effect.relation_demand !== undefined) {
      const key = pairKey(effect.relation_demand.subject, effect.relation_demand.predicate);
      demandWork += 1;
      const existing = state.pair_demands.has(key);
      if (!existing) demandWork += newPairs.length;
      if (!existing && !newPairs.includes(key)) {
        pairBytes += 96 + Buffer.byteLength(key, "utf8");
        newPairs.push(key);
      }
    }
    if (effect.source_fact_demand !== undefined) {
      demandWork += 1;
      if (!state.source_facts?.has(effect.source_fact_demand)) {
        const existing = state.source_fact_demands.has(effect.source_fact_demand);
        if (!existing) demandWork += newSources.length;
        if (!existing && !newSources.includes(effect.source_fact_demand)) {
          sourceFactBytes += 96 + Buffer.byteLength(effect.source_fact_demand, "utf8");
          newSources.push(effect.source_fact_demand);
        }
      }
    }
    if (effect.facet !== undefined) {
      const target = effect.transition?.to ?? effect.hyperedge?.to;
      if (target === undefined) facetResumeOffset = 0;
      else for (let index = 0; index < facetResumeOffset; index += 1) {
        demandWork += 1;
        if (productStateNodeId(priorStates.at(index)!) === productStateNodeId(target)) {
          facetResumeOffset = index;
          break;
        }
      }
    }
  }
  demandBytes = pairBytes + sourceFactBytes;
  if (advanced.work + demandWork > state.remaining_exploration
    || advanced.retained_bytes - pending.retained_bytes + demandBytes > state.remaining_memory_bytes) {
    return interrupted({ ...state, pending_path_effects: { ...retained, offset: pending.offset },
      remaining_exploration: Math.max(0, state.remaining_exploration - advanced.work - demandWork),
      remaining_memory_bytes: Math.max(0, state.remaining_memory_bytes -
        (advanced.retained_bytes - pending.retained_bytes)) },
    advanced.retained_bytes - pending.retained_bytes + demandBytes > state.remaining_memory_bytes);
  }
  const prepared = { ...state, pending_path_effects: retained,
    binding_contexts: cursor.bindingContexts?.snapshot() ?? state.binding_contexts,
    remaining_exploration: state.remaining_exploration - advanced.work - demandWork,
    remaining_memory_bytes: Math.max(0, state.remaining_memory_bytes - (advanced.retained_bytes - pending.retained_bytes) - demandBytes) };
  const page: ObserverPage = { ...pending.page,
    outcome: { ...pending.page.outcome, status: advanced.status === "complete" ? pending.page.outcome.status : "open" },
    open_regions: pending.page.open_regions.map((region) => region.region_id === pending.page.cursor.region_id
      && advanced.status !== "complete" ? { ...region, status: "open" } : region) };
  const applied = applyObserverPage(prepared, { page, effects: advanced.effects });
  // A failed retention leaves the prior offset live; the cursor replays these effects.
  if (applied.retention_rejected !== undefined || applied.memory_exhausted) return interrupted(applied, applied.memory_exhausted);
  let pairDemands = state.pair_demands;
  const sourceFactDemands = new SourceFactDemands(state.source_fact_demands,
    state.source_fact_pending_count, state.source_fact_scan_offset, state.source_fact_demand_bytes);
  for (const key of newPairs) pairDemands = pairDemands.with(key, true);
  for (const id of newSources) sourceFactDemands.add(id);
  let subjects = applied.resume_subjects;
  for (const effect of advanced.effects) {
    const transition = effect.transition ?? effect.hyperedge;
    if (transition !== undefined) { subjects = subjects.with(productEndpointId(transition.from), true).with(productEndpointId(transition.to), true); }
    if (effect.discovery !== undefined) subjects = subjects.with(effect.discovery.subject_id, true);
  }
  const finished = advanced.status === "complete";
  const prior = pending.input.options;
  const newFacets = applied.facets.length !== (prior.facets?.length ?? 0);
  const guardsSeen = pending.guards_seen === true || advanced.effects.some((effect) => effect.unresolved_guard === true);
  // Only a complete pass can replace the prior guard result. A new source fact
  // replays retained rows, so an obsolete unknown can clear without hiding an
  // independent unknown encountered elsewhere in the same pass.
  const guards = finished ? (prior.liveStateOffset ?? 0) === 0 ? guardsSeen
    : state.observation_gaps?.guards === true || guardsSeen
    : state.observation_gaps?.guards === true;
  const measurements = state.observation_gaps?.measurements === true || advanced.effects.some((effect) => effect.missing_measurement === true);
  const missingRevision = advanced.effects.some((effect) => effect.missing_target_revision === true);
  const semanticDelta = finished && (applied.seen_identities.length > prior.liveStates.length || newFacets
    || applied.discoveries.length > (prior.discoveries?.length ?? 0) || missingRevision);
  const next = semanticDelta ? { input: { rows: pending.input.rows, options: { ...prior,
    bindingContexts: applied.binding_contexts,
    liveStates: applied.seen_identities, liveStateOffset: missingRevision ? 0 : facetResumeOffset,
    facets: applied.facets, discoveries: applied.discoveries } }, offset: 0, retained_bytes: 0,
    page: { ...page, observations: [], outcome: { ...page.outcome, status: "open" as const } } } : undefined;
  return { ...applied, resume_subjects: subjects,
    pair_demands: pairDemands, pair_demand_bytes: state.pair_demand_bytes + pairBytes,
    source_fact_demands: sourceFactDemands.snapshot, source_fact_demand_bytes: sourceFactDemands.bytes,
    source_fact_pending_count: sourceFactDemands.pending, source_fact_scan_offset: sourceFactDemands.offset,
    binding_context_bytes: finished ? applied.binding_contexts?.bytes : applied.binding_context_bytes,
    ...(finished && !semanticDelta ? { path_effect_frontier: { identities: applied.seen_identities.length,
      facets: applied.facets, discoveries: applied.discoveries.length, sourceFacts: applied.source_facts } } : {}),
    observation_gaps: { guards, measurements },
    pending_path_effects: finished ? next : { ...retained, guards_seen: guardsSeen,
      facet_resume_offset: facetResumeOffset,
      offset: advanced.offset, page: { ...page, observations: [] } },
    remaining_memory_bytes: applied.remaining_memory_bytes + (finished ? advanced.retained_bytes
      - ((applied.binding_contexts?.bytes ?? 0) - (prior.bindingContexts?.bytes ?? 0)) : 0),
    ...(finished && !semanticDelta ? {} : { last_observer_status: "interrupted" as const,
      closure: { ...applied.closure, observation: "interrupted" as const, requested_index: "open" as const } }) };
}

function interrupted(state: FieldEngineState, memory: boolean): FieldEngineState {
  return { ...state, memory_exhausted: memory, last_observer_status: "interrupted",
    closure: { ...state.closure, observation: "interrupted", requested_index: "open" },
    residuals: state.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
}
