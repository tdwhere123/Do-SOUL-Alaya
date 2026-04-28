export const DYNAMICS_CONSTANTS = Object.freeze({
  decay_profiles: Object.freeze({
    pinned: Object.freeze({ half_life: Infinity, r_min: 0.8 }),
    stable: Object.freeze({ half_life: 90 * 24 * 3600 * 1000, r_min: 0.3 }),
    normal: Object.freeze({ half_life: 30 * 24 * 3600 * 1000, r_min: 0.1 }),
    volatile: Object.freeze({ half_life: 7 * 24 * 3600 * 1000, r_min: 0.05 }),
    hazard: Object.freeze({ half_life: 365 * 24 * 3600 * 1000, r_min: 0.5 })
  }),
  karma: Object.freeze({
    accept_gain: 0.15,
    reuse_gain: 0.05,
    evidence_gain: 0.1,
    supersede_penalty: -0.2,
    reject_penalty: -0.3
  }),
  activation_weights_phase1b: Object.freeze({
    scope_match: 0.27,
    domain_match: 0.27,
    retention: 0.27,
    freshness: 0.19
  }),
  activation_weights_phase4b: Object.freeze({
    scope_match: 0.18,
    domain_match: 0.18,
    retention: 0.18,
    freshness: 0.16,
    relevance: 0.1,
    graph_support: 0.05,
    budget_penalty: 0.1,
    conflict_penalty: 0.05
  }),
  manifestation_thresholds: Object.freeze({
    hidden_max: 0.1,
    hint_max: 0.3,
    excerpt_max: 0.6,
    full_min: 0.6
  }),
  manifestation_budget: Object.freeze({
    default_stance_bias_cap: 10,
    default_dialogue_nudge_cap: 3,
    default_lens_entry_cap: 1,
    default_nudge_min_pressure: 0.4,
    default_nudge_min_confidence: 0.5,
    default_lens_min_pressure: 0.7,
    default_lens_min_confidence: 0.7
  }),
  path_plasticity: Object.freeze({
    reinforcement_increment: 0.1,
    weakening_decrement: -0.05,
    salience_boost_on_hit: 0.15,
    volatile_to_normal_support_count: 5,
    normal_to_stable_support_count: 15,
    stable_to_pinned_support_count: 50,
    retirement_cooldown_ms: 7 * 24 * 3600 * 1000,
    consolidation_fuse_max_retries: 3,
    consolidation_fuse_cooldown_ms: 60_000
  })
} as const);

export type DynamicsConstants = typeof DYNAMICS_CONSTANTS;
