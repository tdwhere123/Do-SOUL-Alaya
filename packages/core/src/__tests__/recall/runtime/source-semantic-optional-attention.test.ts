import { describe, expect, it } from "vitest";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger, sourceSemanticCorrespondenceIdentity,
  type SourceSemanticAttention
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../../shared/errors.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { sourceSemanticProofDependencies } from "../../../recall/runtime/source-semantic-delivery.js";
import {
  attachOptionalAttention, runOptionalAttention
} from "../../../recall/runtime/source-semantic-optional-attention.js";
import {
  executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET
} from "../../../recall/runtime/source-semantic-reasoning.js";
import { CLOCK, correspondenceFor, ORIGINAL, query, source } from "./source-semantic-proof-fixture.js";

const RESERVE = { finalization_reserve: 10000, min_envelope: 10 };
const ATTENTION = { kind: "computed", truncated: false } as SourceSemanticAttention;

describe("optional semantic attention accounting", () => {
  it("omits attention on child exhaustion and debits only successful child spend", () => {
    const parent = new SourceSemanticResourceLedger({ work_units: 10050, memory_bytes: 100 });
    expect(runOptionalAttention(parent, RESERVE, (child) => {
      child.charge(40, 90, "semantic attention product advance");
      child.charge(1, 0, "semantic attention product advance");
      return ATTENTION;
    })).toBeUndefined();
    expect(parent.spentWork).toBe(40);
    expect(parent.spentBytes).toBe(90);
    expect(parent.remaining()).toEqual({ work_units: 10010, memory_bytes: 10 });
  });

  it("does not debit a failed first charge and preserves unknown successful attention", () => {
    const parent = new SourceSemanticResourceLedger({ work_units: 10010, memory_bytes: 20 });
    expect(runOptionalAttention(parent, RESERVE, (child) => {
      child.charge(1, 0, "semantic attention product advance");
      return ATTENTION;
    })).toBeUndefined();
    expect(parent.spentWork).toBe(0);
    expect(parent.remaining().work_units).toBe(10010);
    const ample = new SourceSemanticResourceLedger({ work_units: 20000, memory_bytes: 100 });
    expect(runOptionalAttention(ample, RESERVE, () => ATTENTION)).toBe(ATTENTION);
    const body = { outcome: { status: "resource_exhausted" as const }, consumed_leaves: [] as const };
    expect(attachOptionalAttention(body, parent, RESERVE, () => {
      throw new SourceSemanticResourceExhausted("semantic attention product advance");
    })).toBe(body);
  });

  it("propagates non-exhaustion errors after debiting successful child work", () => {
    const parent = new SourceSemanticResourceLedger({ work_units: 20000, memory_bytes: 100 });
    expect(() => runOptionalAttention(parent, RESERVE, (child) => {
      child.charge(4, 0, "semantic attention product advance");
      throw new CoreError("OBLIGATION_VIOLATION", "attention invariant");
    })).toThrow(CoreError);
    expect(parent.spentWork).toBe(4);
  });
});

describe("required projection stays fail-closed; optional cannot erase it", () => {
  it("keeps no-progress exhaustion without completeness, index, or invented bindings", () => {
    const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
    const admitted = admitSourceSemanticCorrespondence({
      source_interpretation: interpretation, query_semantics: semantics,
      semantic_correspondence: correspondence, original_query: ORIGINAL
    });
    expect(admitted.kind).toBe("admitted");
    if (admitted.kind !== "admitted") return;
    const executed = executeSourceSemanticInterpretation({
      source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
      original_query: ORIGINAL, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
      request: {
        contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: admitted.interpretation_id, query_semantics_id: admitted.query_id,
        semantic_correspondence_id: admitted.semantic_correspondence_id, original_query: ORIGINAL,
        budget: { schema_version: 1, work_units: 2, memory_bytes: 32, page_budget: 1, finalization_reserve: 0, min_envelope: 1 },
        output_byte_limit: 4096
      }
    });
    expect(executed.result.outcome.status).toBe("resource_exhausted");
    expect(executed.result.completeness).toBeUndefined();
    expect(executed.index).toBeNull();
    expect(executed.result.binding_results).toBeUndefined();
    expect(executed.source_dependencies).toBeUndefined();
  });

  it("computes single-phase attention after required proof under an ample budget", () => {
    const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
    const executed = executeSourceSemanticInterpretation({
      source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
      original_query: ORIGINAL, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
      request: {
        contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: correspondence.source_interpretation_id,
        query_semantics_id: correspondence.query_semantics_id,
        semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256),
        original_query: ORIGINAL, budget: SOURCE_SEMANTIC_REASONING_BUDGET, output_byte_limit: 1_000_000
      }
    });
    expect(executed.result.outcome.status).toBe("interpreted");
    expect(executed.index).not.toBeNull();
    expect(executed.result.attention?.kind).toBe("computed");
    expect(executed.result.binding_results?.length).toBeGreaterThan(0);
    expect(executed.source_dependencies?.length).toBeGreaterThan(0);
    expect(() => sourceSemanticProofDependencies(executed.result, new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 0 })))
      .toThrow(SourceSemanticResourceExhausted);
  });

  it("omits optional attention when the required result still fits the output envelope", () => {
    const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
    const input = {
      source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
      original_query: ORIGINAL, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
      request: {
        contract: "source-interpretation-reasoning-v5" as const, accepts_unreviewed_conditional_results: true as const,
        source_interpretation_id: correspondence.source_interpretation_id,
        query_semantics_id: correspondence.query_semantics_id,
        semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256),
        original_query: ORIGINAL, budget: SOURCE_SEMANTIC_REASONING_BUDGET, output_byte_limit: 1_000_000
      }
    };
    const ample = executeSourceSemanticInterpretation(input);
    expect(ample.result.outcome.status).toBe("interpreted");
    expect(ample.result.attention?.kind).toBe("computed");
    expect(ample.index).not.toBeNull();
    expect(ample.result.binding_results?.length).toBeGreaterThan(0);
    expect(ample.source_dependencies?.length).toBeGreaterThan(0);
    const { attention, ...requiredOnly } = ample.result;
    expect(attention).toBeDefined();
    expect(requiredOnly.resource_usage).toEqual(ample.result.resource_usage);
    const requiredBytes = Buffer.byteLength(JSON.stringify(requiredOnly));
    expect(requiredBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(ample.result)));
    const exact = executeSourceSemanticInterpretation({
      ...input, request: { ...input.request, output_byte_limit: requiredBytes }
    });
    expect(exact.result.outcome).toEqual(ample.result.outcome);
    expect(exact.result.binding_results).toEqual(ample.result.binding_results);
    expect(exact.result.completeness).toEqual(ample.result.completeness);
    expect(exact.result.resource_usage).toEqual(ample.result.resource_usage);
    expect(exact.index).toEqual(ample.index);
    expect(exact.source_dependencies).toEqual(ample.source_dependencies);
    expect(exact.result.attention).toBeUndefined();
    expect(exact.result).not.toHaveProperty("attention");
    const below = executeSourceSemanticInterpretation({
      ...input, request: { ...input.request, output_byte_limit: requiredBytes - 1 }
    });
    expect(below.result.outcome.status).toBe("truncated");
    expect(below.index).toBeNull();
    expect(below.result.binding_results).toBeUndefined();
    expect(below.source_dependencies).toBeUndefined();
    expect(ample.result.attention?.kind).toBe("computed");
  });
});
