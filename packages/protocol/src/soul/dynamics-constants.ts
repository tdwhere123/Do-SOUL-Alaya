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
    // Co-usage events for the same memory pair must accrue to this count
    // before PathRelationProposalService mints a PathRelation. Override-capable
    // via dynamics-constants-override (bench lowers it to surface paths early).
    co_usage_threshold: 3,
    reinforcement_increment: 0.1,
    weakening_decrement: -0.05,
    salience_boost_on_hit: 0.15,
    volatile_to_normal_support_count: 3,
    normal_to_stable_support_count: 8,
    stable_to_pinned_support_count: 50,
    retirement_cooldown_ms: 7 * 24 * 3600 * 1000,
    consolidation_fuse_max_retries: 3,
    consolidation_fuse_cooldown_ms: 60_000,
    // Consolidation planner thresholds (S3a). A dormant path is a merge/retire
    // candidate only once it has stayed dormant at least this long; this mirrors
    // the 30-day inactivity window the plasticity decay path already uses to
    // demote a path to dormant, so a path is never consolidated in the same
    // window it went dormant. A mergeable cluster needs at least this many
    // surviving members for a merge to be worthwhile (one survivor + >=1 loser).
    // The merge why-concat is bounded to this many provenance entries so an
    // unbounded chain of merges cannot grow why_this_relation_exists without
    // limit; the executor dedupes then truncates to this cap.
    consolidation_dormant_age_ms: 90 * 24 * 3600 * 1000,
    consolidation_merge_min_cluster_size: 2,
    consolidation_merge_why_max_entries: 16,
    // Feedback-loop-specific tuning. The reinforcement_increment /
    // weakening_decrement above stay authoritative for delta math; these
    // additional constants only cover clamping and retirement preconditions.
    // The 30-day inactivity window is distinct from the 7-day
    // retirement_cooldown_ms above: one triggers retirement, the other
    // controls the post-retirement re-arm window.
    strength_floor: 0,
    strength_ceiling: 1,
    retirement_strength_threshold: 0.05,
    retirement_inactivity_ms: 30 * 24 * 3600 * 1000,
    // Positive-associative-family paths that hit retirement_strength_threshold
    // while inactive go dormant (reversible) instead of retired (terminal).
    // A dormant path is restored to this strength when a revive trigger
    // fires (usage receipt or explicit override).
    revive_strength: 0.2
  }),
  // Asynchronous memory enrichment (conflict detection + edge auto-production)
  // is decoupled from the synchronous write-path: materialization enqueues an
  // enrich_pending marker and acks; the Garden BULK_ENRICH Librarian task
  // drains the markers in batches and runs the governed enrichment services.
  // These are design-justified thresholds, not bench-tuned literals.
  // - batch_trigger_count: an accumulated pending count of this size triggers a
  //   BULK_ENRICH cycle between the periodic Librarian passes, so enrichment
  //   never lags an unbounded number of writes behind. Mirrors the S3c design's
  //   "accumulate N=50" trigger.
  // - claim_batch_size: the maximum number of pending markers one BULK_ENRICH
  //   cycle claims and processes, bounding per-cycle work so a large backlog
  //   drains across several cycles instead of one unbounded pass.
  // - claim_stale_after_ms: a claimed-but-unprocessed marker older than this is
  //   presumed crashed (the daemon died between claimBatch and markProcessed)
  //   and is reclaimed back to claimable so a later cycle re-drains it — the
  //   same TTL-reclaim safety net garden_task has (GARDEN_CLAIM_STALE_AFTER_MS).
  //   Sized generously above a normal in-process drain duration so a live,
  //   still-running cycle is never reclaimed out from under itself; the only
  //   claimant is the single in-process Garden worker, so this is purely the
  //   crash-recovery upper bound, not a contention knob. 10 min mirrors the
  //   garden_task rationale ("long enough for a real round-trip, short enough
  //   that a restart re-drains promptly").
  enrich: Object.freeze({
    batch_trigger_count: 50,
    claim_batch_size: 50,
    claim_stale_after_ms: 10 * 60 * 1000
  })
} as const);

export type DynamicsConstants = typeof DYNAMICS_CONSTANTS;
