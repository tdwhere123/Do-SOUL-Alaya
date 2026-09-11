import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  CompletenessReportSchema,
  CoverageRegionSchema,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  productSubjectId,
  type CoverageRegion,
  type QueryInterpretation,
  type SeedActivation
} from "@do-soul/alaya-protocol";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  certifyClosure,
  classifyResidualInfluence,
  composeCompleteness,
  residualGradeUpper,
  residualsInvalidateBounds,
  upperExcludesPredicate
} from "../../../../recall/conditional-field/index/completeness.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  deploymentProgram,
  productKey
} from "../reference/deployment.fixture.js";
import type { ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { deploymentWorld } from "../../conditional-field-oracle/finite-worlds.js";
import {
  enumerateCompletions,
  enumerateWorldCompletions,
  oracleAllowsComplete,
  oracleGuaranteedMembers,
  oraclePossibleMembers,
  oracleSandwichHolds,
  oracleStability,
  orderOf,
  type OracleClaim,
  type SourceModel
} from "../../conditional-field-oracle/completeness-oracle.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;

describe("residual influence and completeness", () => {
  it("reproduces G07: unknown residual keeps logical-open from repairing a tight numeric upper", () => {
    const known = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [seed("r", 400)],
      residuals: exhaustedRegions({ seed: "unknown" })
    });
    expect(known.closure.requested_index).not.toBe("complete");
    expect(gradeOf(known, "r")).toBe(400);
    expect(lowOf(known, "r")).toBe(400);
    expect(highOf(known, "r")).toBe(MILLIGRADE_TOP);
    expect(highOf(known, "r")).toBeGreaterThan(gradeOf(known, "r"));
  });

  it("keeps mixed observeField open when memory is exhausted and source coverage is missing", () => {
    const mixed = observeField(epsilonInterpretation("mixed"), {
      workspace_id: "ws",
      query_text: "needle",
      budget: defaultBudget(),
      as_of: "2026-01-01T00:00:00.000Z",
      authorized_scopes: null,
      readers: memoryOnlyReaders("r")
    });
    const source = mixed.residuals.find((region) => region.kind === "source_domain");
    expect(source?.coverage_role).toBe("required");
    expect(source?.status).toBe("unknown");
    expect(source?.hypothesis_id).toBe("h0");
    expect(source?.program_branch).toBe("accepting");
    expect(source?.output_obligations).toEqual(["membership"]);
    expect(mixed.closure.requested_index).not.toBe("complete");
    expect(highOf(mixed, "r")).toBe(MILLIGRADE_TOP);
    if (gradeOf(mixed, "r") < MILLIGRADE_TOP) {
      expect(highOf(mixed, "r")).toBeGreaterThan(gradeOf(mixed, "r"));
    }

    const truncated = observeField(epsilonInterpretation("mixed"), {
      workspace_id: "ws",
      query_text: "needle",
      budget: defaultBudget(),
      as_of: "2026-01-01T00:00:00.000Z",
      authorized_scopes: null,
      readers: truncatedSourceReaders()
    });
    const truncatedSource = truncated.residuals.find((region) => region.kind === "source_domain");
    expect(truncatedSource?.coverage_role).toBe("required");
    expect(truncatedSource?.status).toBe("open");
    expect(truncated.closure.requested_index).not.toBe("complete");
    const index = projectAcceptingIndex({
      snapshot: truncated.binding.kind === "bound" ? truncated.binding.snapshot : {
        schema_version: SCHEMA,
        snapshot_id: SNAPSHOT_ID,
        query_id: QUERY_ID,
        seeds: [],
        values: [],
        retained_transitions: [],
        facets: []
      },
      view: epsilonInterpretation("mixed").view,
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget(),
      observer: {
        outcome: { schema_version: SCHEMA, status: truncated.closure.observation },
        open_regions: truncated.residuals
      }
    });
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.order_status).not.toBe("complete");
  });

  it("classifies by semantic effect: optional accelerator vs required measurement", () => {
    const optional = region("discovery", "discovery", "unknown", {
      coverage_role: "optional_accelerator"
    });
    const required = region("binding", "binding", "unavailable", {
      coverage_role: "required"
    });
    expect(classifyResidualInfluence(optional, { sufficient_alternate_paths: true }, "membership"))
      .toBe("influential");
    expect(classifyResidualInfluence(optional, { sufficient_alternate_paths: true }, "grade_bound"))
      .toBe("influential");
    expect(classifyResidualInfluence(optional, { sufficient_alternate_paths: false }, "membership"))
      .toBe("influential");
    expect(classifyResidualInfluence(required)).toBe("unresolved");
    const report = composeCompleteness({
      observer: {
        outcome: { schema_version: SCHEMA, status: "unknown" },
        open_regions: [optional]
      },
      sufficient_alternate_paths: true,
      total: 1,
      remaining: 0,
      omitted_payload: false,
      expand_payload: true
    });
    expect(report.logical_index).not.toBe("complete");
    const covered = certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "required_regions_irrelevant",
      closed_effects: ["membership"],
      residuals: [region("seed", "seed", "exhausted")],
      result_kind_view: "memory_only"
    });
    expect(covered?.closed_obligations).toEqual(["membership"]);
    expect(classifyResidualInfluence(optional, { certificate: covered }, "membership"))
      .toBe("irrelevant");
    expect(classifyResidualInfluence(optional, { certificate: covered }, "grade_bound"))
      .toBe("influential");
    const unresolved = composeCompleteness({
      observer: {
        outcome: { schema_version: SCHEMA, status: "exhausted" },
        open_regions: [required]
      },
      total: 0,
      remaining: 0,
      omitted_payload: false,
      expand_payload: true
    });
    expect(unresolved.logical_index).not.toBe("complete");
    expect(unresolved.observed_coverage).toBe("unavailable");
  });

  it("does not close order or refutation from a membership certificate", () => {
    const membershipOnly = certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "required_regions_irrelevant",
      closed_effects: ["membership"],
      residuals: [region("seed", "seed", "exhausted")],
      program_id: "epsilon",
      result_kind_view: "memory_only",
      hypothesis_id: "h0",
      binding: "default"
    });
    expect(membershipOnly?.closed_effects).toEqual(["membership"]);
    expect(membershipOnly?.closed_effects).not.toContain("order");
    expect(membershipOnly?.closed_effects).not.toContain("refutation");
    expect(membershipOnly?.closed_obligations).toEqual(["membership"]);
    expect(membershipOnly?.program_id).toBe("epsilon");
    expect(membershipOnly?.result_kind_view).toBe("memory_only");
    expect(membershipOnly?.target_kinds).toEqual(["memory_entry"]);
    expect(membershipOnly?.includes_source_only).toBe(false);
    expect(certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "required_regions_irrelevant",
      closed_effects: ["membership", "order", "refutation"],
      residuals: [region("seed", "seed", "exhausted"), region("order", "cursor", "open")]
    })).toBeUndefined();
    const wired = composeCompleteness({
      observer: {
        outcome: { schema_version: SCHEMA, status: "exhausted" },
        open_regions: [region("seed", "seed", "exhausted")]
      },
      query_id: QUERY_ID,
      program_id: "epsilon",
      result_kind_view: "memory_only",
      total: 1,
      remaining: 0,
      omitted_payload: false,
      expand_payload: true
    });
    expect(wired.certificate_id).toBeDefined();
    expect(wired.order_coverage).toBe("open");
    const roundTripRegion = CoverageRegionSchema.parse(JSON.parse(JSON.stringify(region(
      "unseen-source",
      "source_domain",
      "unknown",
      {
        source_domain: "source_evidence",
        hypothesis_id: "h0",
        program_branch: "accepting",
        output_obligations: ["membership"],
        conservative_bound_milligrades: MILLIGRADE_TOP
      }
    ))));
    expect(roundTripRegion.kind).toBe("source_domain");
    expect(CompletenessReportSchema.parse(JSON.parse(JSON.stringify(wired))).certificate_id)
      .toBe(wired.certificate_id);
  });

  it("does not certify complete from an exhausted required seed while source_domain is unknown", () => {
    const residuals = [
      region("seed", "seed", "exhausted", { coverage_role: "required" }),
      region("source_domain", "source_domain", "unknown", {
        coverage_role: "required",
        source_domain: "source_evidence",
        conservative_bound_milligrades: MILLIGRADE_TOP
      })
    ];
    expect(classifyResidualInfluence(residuals[0]!, {}, "membership")).toBe("irrelevant");
    expect(classifyResidualInfluence(residuals[1]!, {}, "membership")).toBe("unresolved");
    expect(certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "required_regions_irrelevant",
      closed_effects: ["membership"],
      residuals,
      result_kind_view: "mixed"
    })).toBeUndefined();
    expect(certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "alternate_source_path",
      closed_effects: ["membership"],
      residuals,
      sufficient_alternate_paths: true,
      result_kind_view: "mixed"
    })).toBeUndefined();
    const completeness = composeCompleteness({
      observer: {
        outcome: { schema_version: SCHEMA, status: "exhausted" },
        open_regions: residuals
      },
      result_kind_view: "mixed",
      query_id: QUERY_ID,
      total: 1,
      remaining: 0,
      omitted_payload: false,
      expand_payload: true
    });
    expect(completeness.logical_index).not.toBe("complete");
  });

  it("enumerates compatible completions independently and sandwiches production field bounds", () => {
    expect(enumerateWorldCompletions(deploymentWorld()).length).toBeGreaterThan(0);
    const models: readonly SourceModel[] = [
      { known: { id: "r", grade: 400 }, unknown_seed: true },
      { known: { id: "r", grade: 400 }, required_measurement: true },
      { known: { id: "r", grade: 800 }, optional_discovery: true },
      { incompatible_hypotheses: true },
      {
        known: { id: "r", grade: 825 },
        comparison: "gt",
        threshold: 800,
        quantized_threshold: 850,
        uses_raw: true,
        between_grade: 825
      },
      {
        known: { id: "r", grade: 850 },
        comparison: "gte",
        threshold: 850,
        uses_raw: true
      },
      { known: { id: "r", grade: 400 }, partial_source: true },
      { known: { id: "r", grade: 700 }, unfinished_join: true, join_strength: 600 },
      { known: { id: "r", grade: 400 }, later_refutation: true }
    ];
    for (const model of models) {
      const completions = enumerateCompletions(model);
      expect(completions.length).toBeGreaterThan(0);
      const residuals = residualsFor(model);
      const field = createConditionalField({
        interpretation: interpretation(),
        budget: defaultBudget(),
        seeds: model.known === undefined ? [] : [seed(model.known.id, model.known.grade)],
        residuals
      });
      const observedMembers = fieldMembers(field);
      const observedClaims = claimsFromField(field, observedMembers);
      const observedOrder = orderOf(observedMembers.map((id) => ({
        id,
        grade: gradeOf(field, id)
      })));
      const lower = {
        members: observedMembers,
        claims: observedClaims,
        order: observedOrder
      };
      const allowed = oracleAllowsComplete(lower, completions);
      const stability = oracleStability(lower, completions);
      const completeness = composeCompleteness({
        observer: {
          outcome: { schema_version: SCHEMA, status: observerStatusOf(residuals) },
          open_regions: residuals
        },
        pending_computation: model.unfinished_join === true ? "open" : "complete",
        claim_work: model.later_refutation === true ? "open" : "complete",
        query_id: QUERY_ID,
        result_kind_view: "mixed",
        total: observedMembers.length,
        remaining: 0,
        omitted_payload: false,
        expand_payload: true
      });
      if (!stability.membership) {
        expect(completeness.logical_index, JSON.stringify({ model, completeness })).not.toBe("complete");
        expect(field.closure.requested_index).not.toBe("complete");
      }
      if (!stability.claim) {
        expect(completeness.claim_coverage).not.toBe("complete");
      }
      if (!stability.order) {
        expect(completeness.order_coverage).not.toBe("complete");
      }
      if (completeness.logical_index === "complete"
        && completeness.claim_coverage === "complete"
        && completeness.order_coverage === "complete") {
        expect(allowed).toBe(true);
      }
      const guaranteed = oracleGuaranteedMembers(completions);
      const possible = oraclePossibleMembers(completions);
      const observedSet = new Set(observedMembers);
      expect([...guaranteed].every((id) => observedSet.has(id) || possible.has(id))).toBe(true);
      expect(oracleSandwichHolds({
        lower: guaranteed,
        upper: possible.size === guaranteed.size ? possible : "unbounded",
        completions
      })).toBe(true);
      expect([...observedSet].every((id) => possible.has(id) || !guaranteed.has(id))).toBe(true);
      for (const completion of completions) {
        for (const member of completion.members) {
          if (!observedSet.has(member.id)) continue;
          const low = lowOf(field, member.id);
          const high = highOf(field, member.id);
          expect(low, member.id).toBeDefined();
          expect(high, member.id).toBeDefined();
          expect(low!).toBeLessThanOrEqual(member.grade);
          expect(member.grade).toBeLessThanOrEqual(high!);
        }
      }
      if (model.between_grade !== undefined && model.threshold !== undefined
        && model.quantized_threshold !== undefined) {
        const rawHit = completions.some((completion) =>
          completion.members.some((member) => member.grade > model.threshold!));
        const quantizedHit = completions.some((completion) =>
          completion.members.some((member) => member.grade > model.quantized_threshold!));
        expect(rawHit).toBe(true);
        expect(quantizedHit).toBe(false);
        expect(upperExcludesPredicate({
          comparison: "gt",
          upper: model.between_grade,
          threshold: model.quantized_threshold,
          uses_raw_predicate: false,
          quantized_cap_only: true
        })).toBe(false);
      }
    }
  });

  it("discards invalidated-epoch bounds and refuses vacuous certificates", () => {
    const invalidated = exhaustedRegions({ seed: "invalidated" });
    expect(residualsInvalidateBounds(invalidated)).toBe(true);
    expect(residualGradeUpper(invalidated)).toBe(MILLIGRADE_TOP);
    const field = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds: [seed("r", 400)],
      residuals: invalidated
    });
    expect(lowOf(field, "r")).toBe(MILLIGRADE_BOTTOM);
    expect(highOf(field, "r")).toBe(MILLIGRADE_TOP);
    expect(certifyClosure({
      query_id: QUERY_ID,
      predicate_id: "assoc",
      operator_id: "max-min",
      domain_id: ASSOCIATION_DOMAIN_ID,
      coverage_premise: "required_regions_irrelevant",
      closed_effects: ["membership"],
      residuals: invalidated
    })).toBeUndefined();
  });
});

function residualsFor(model: SourceModel): readonly CoverageRegion[] {
  const rows: CoverageRegion[] = [];
  if (model.unknown_seed === true) {
    rows.push(region("seed", "seed", "unknown"));
  } else if (model.incompatible_hypotheses === true) {
    rows.push(region("seed", "seed", "exhausted"));
  } else {
    rows.push(region("seed", "seed", model.known === undefined ? "open" : "exhausted"));
  }
  rows.push(region("adjacency", "adjacency", "exhausted"));
  rows.push(region("guard", "guard", "exhausted"));
  if (model.required_measurement === true) {
    rows.push(region("binding", "binding", "unavailable", { coverage_role: "required" }));
  } else {
    rows.push(region("binding", "binding", "exhausted"));
  }
  if (model.optional_discovery === true) {
    rows.push(region("discovery", "discovery", "unknown", {
      coverage_role: "optional_accelerator"
    }));
  }
  if (model.incompatible_hypotheses === true) {
    rows.push(region("h0", "hypothesis", "open", { hypothesis_id: "h0" }));
    rows.push(region("h1", "hypothesis", "open", { hypothesis_id: "h1" }));
  }
  if (model.partial_source === true || model.unknown_seed === true) {
    rows.push(region("source", "source_domain", "unknown", {
      source_domain: "source_evidence",
      coverage_role: "required",
      conservative_bound_milligrades: MILLIGRADE_TOP
    }));
  }
  if (model.unfinished_join === true) {
    rows.push(region("join", "program_branch", "open", { program_branch: "join" }));
  }
  if (model.later_refutation === true) {
    rows.push(region("claim", "output_obligation", "open", {
      output_obligations: ["refutation"],
      semantic_effects: ["refutation", "claim"]
    }));
  }
  return rows;
}

function observerStatusOf(residuals: readonly CoverageRegion[]): CoverageRegion["status"] {
  if (residuals.some((region) => region.status === "unavailable")) return "unavailable";
  if (residuals.some((region) => region.status === "unknown")) return "unknown";
  if (residuals.some((region) => region.status === "open")) return "open";
  return "exhausted";
}

function exhaustedRegions(
  override: Readonly<Record<string, CoverageRegion["status"]>>
): readonly CoverageRegion[] {
  return (["seed", "adjacency", "guard", "binding"] as const).map((kind) =>
    region(kind, kind, override[kind] ?? "exhausted"));
}

function region(
  id: string,
  kind: CoverageRegion["kind"],
  status: CoverageRegion["status"],
  extra: Partial<CoverageRegion> = {}
): CoverageRegion {
  return {
    schema_version: SCHEMA,
    region_id: id,
    kind,
    status,
    ...extra
  };
}

function interpretation(): QueryInterpretation {
  return {
    schema_version: SCHEMA,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: deploymentProgram(),
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function epsilonInterpretation(kindView: "mixed" | "memory_only" | "source_only"): QueryInterpretation {
  return {
    schema_version: SCHEMA,
    query_id: QUERY_ID,
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: { schema_version: SCHEMA, kind: "epsilon" },
    view: { ...defaultView(), result_kind_view: kindView },
    holes: [],
    hypotheses: []
  };
}

function seed(objectId: string, milligrades: number): SeedActivation {
  return { schema_version: SCHEMA, state: productKey(objectId), milligrades };
}

function memoryOnlyReaders(objectId: string): ObserverReaders {
  return {
    lexical: () => ({
      ids: [objectId],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 1,
      bytesRead: 1,
      truncated: false
    }),
    source: (input) => ({
      row: {
        object_id: input.objectId,
        sourceRevision: "rev",
        lifecycle_state: "active",
        scope_class: "project"
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    })
  };
}

function truncatedSourceReaders(): ObserverReaders {
  return {
    lexical: () => ({
      ids: [],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 0,
      bytesRead: 0,
      truncated: false
    }),
    sourceRoots: () => ({
      rows: [],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 0,
      bytesRead: 0,
      truncated: true
    })
  };
}

function fieldMembers(state: ReturnType<typeof createConditionalField>): readonly string[] {
  if (state.binding.kind !== "bound") return [];
  return state.binding.snapshot.values
    .filter((row) => row.accepting && row.activation?.kind !== "unreachable")
    .map((row) => productSubjectId(row.state));
}

function claimsFromField(
  state: ReturnType<typeof createConditionalField>,
  members: readonly string[]
): Readonly<Record<string, OracleClaim>> {
  return Object.fromEntries(members.map((id) => {
    const claim = state.claims.get(id);
    if (claim === "supported" || claim === "refuted" || claim === "unknown") return [id, claim];
    return [id, "unknown"];
  }));
}

function gradeOf(state: ReturnType<typeof createConditionalField>, objectId: string): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.milligrades ?? 0;
}

function lowOf(
  state: ReturnType<typeof createConditionalField>,
  objectId: string
): number | undefined {
  if (state.binding.kind !== "bound") return undefined;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.low_milligrades;
}

function highOf(
  state: ReturnType<typeof createConditionalField>,
  objectId: string
): number | undefined {
  if (state.binding.kind !== "bound") return undefined;
  return state.binding.snapshot.values.find((row) => productSubjectId(row.state) === objectId)
    ?.high_milligrades;
}
