import { productSubjectId, type ObserverPage } from "@do-soul/alaya-protocol";
import { applyObserverPage, type FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { createAdjacencyEffectCursor } from "../conditional-field/engine/path-composition.js";

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
  const retained = { ...pending, cursor, retained_bytes: advanced.retained_bytes, completed_work: advanced.completed_work };
  const prepared = { ...state, pending_path_effects: retained,
    remaining_exploration: state.remaining_exploration - advanced.work,
    remaining_memory_bytes: Math.max(0, state.remaining_memory_bytes - (advanced.retained_bytes - pending.retained_bytes)) };
  if (advanced.status === "memory_exhausted") return interrupted(prepared, true);
  const page: ObserverPage = { ...pending.page,
    outcome: { ...pending.page.outcome, status: advanced.status === "complete" ? pending.page.outcome.status : "open" },
    open_regions: pending.page.open_regions.map((region) => region.region_id === pending.page.cursor.region_id
      && advanced.status !== "complete" ? { ...region, status: "open" } : region) };
  const applied = applyObserverPage(prepared, { page, effects: advanced.effects });
  // A failed retention leaves the prior offset live; the cursor replays these effects.
  if (applied.retention_rejected !== undefined || applied.memory_exhausted) return interrupted(applied, applied.memory_exhausted);
  let subjects = applied.resume_subjects;
  for (const effect of advanced.effects) {
    const transition = effect.transition ?? effect.hyperedge;
    if (transition !== undefined) { subjects = subjects.with(productSubjectId(transition.from), true).with(productSubjectId(transition.to), true); }
    if (effect.discovery !== undefined) subjects = subjects.with(effect.discovery.subject_id, true);
  }
  const finished = advanced.status === "complete";
  const prior = pending.input.options;
  const newFacets = applied.facets.length !== (prior.facets?.length ?? 0);
  const guards = state.observation_gaps?.guards === true || advanced.effects.some((effect) => effect.unresolved_guard === true);
  const measurements = state.observation_gaps?.measurements === true || advanced.effects.some((effect) => effect.missing_measurement === true);
  const missingRevision = advanced.effects.some((effect) => effect.missing_target_revision === true);
  const semanticDelta = finished && (applied.seen_identities.length > prior.liveStates.length || newFacets
    || applied.discoveries.length > (prior.discoveries?.length ?? 0) || missingRevision);
  const next = semanticDelta ? { input: { rows: pending.input.rows, options: { ...prior,
    liveStates: applied.seen_identities, liveStateOffset: newFacets || missingRevision ? 0 : prior.liveStates.length,
    facets: applied.facets, discoveries: applied.discoveries } }, offset: 0, retained_bytes: 0,
    page: { ...page, observations: [], outcome: { ...page.outcome, status: "open" as const } } } : undefined;
  return { ...applied, resume_subjects: subjects,
    ...(finished && !semanticDelta ? { path_effect_frontier: { identities: applied.seen_identities.length,
      facets: applied.facets, discoveries: applied.discoveries.length } } : {}),
    observation_gaps: guards || measurements ? { guards, measurements } : state.observation_gaps,
    pending_path_effects: finished ? next : { ...retained, offset: advanced.offset, page: { ...page, observations: [] } },
    remaining_memory_bytes: applied.remaining_memory_bytes + (finished ? advanced.retained_bytes : 0),
    ...(finished && !semanticDelta ? {} : { last_observer_status: "interrupted" as const,
      closure: { ...applied.closure, observation: "interrupted" as const, requested_index: "open" as const } }) };
}

function interrupted(state: FieldEngineState, memory: boolean): FieldEngineState {
  return { ...state, memory_exhausted: memory, last_observer_status: "interrupted",
    closure: { ...state.closure, observation: "interrupted", requested_index: "open" },
    residuals: state.residuals.map((region) => region.status === "open" ? { ...region, status: "interrupted" } : region) };
}
