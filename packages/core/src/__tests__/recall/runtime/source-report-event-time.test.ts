import { describe, expect, it } from "vitest";
import {
  materializeSourceSemanticQueryMeaning, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticCorrespondence, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, receiveSourceSemantics } from "@do-soul/alaya-soul";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { digestOriginalQuery } from "../../../recall/conditional-field/query/compile-query-identity.js";
import { admitSourceSemanticQuery } from "../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { CLOCK, run } from "./source-semantic-proof-fixture.js";

const SOURCE = "On 2026-04-09, Omar reported that Talia might approve grant G-8 on 2026-04-10.";
const REPORT_DATE = "2026-04-09", APPROVAL_DATE = "2026-04-10";

// Authored interpretation of one source sentence; no retained provider response is repaired.
function interpretReport(includeReportDate = true): SourceSemanticInterpretation {
  const input = { sourceCorpus: SOURCE, assertionIds: [1], sourceScope: "complete-source" as const,
    source_id: "dated-report", source_version: "1", producer_id: "authored-control", producer_version: "1" };
  const request = buildSourceSemanticRequest(input);
  const select = (text: string) => {
    const start = SOURCE.indexOf(text);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(SOURCE.indexOf(text, start + 1)).toBe(-1);
    return { assertion_id: 1, text };
  };
  const proposal = { contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content: {
    roots: [{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "report", support: select("reported") },
      arguments: [
        { role: "reporter", target: select("Omar") },
        ...(includeReportDate ? [{ role: "time", target: select(REPORT_DATE) }] : []),
        { role: "content", support: select("might"), target: {
          kind: "possible", support: select("might"), content: {
            kind: "statement", predicate: { kind: "explicit", reading: "approve", support: select("approve") },
            arguments: [
              { role: "approver", target: select("Talia") },
              { role: "item", target: select("grant G-8") },
              { role: "time", target: select(APPROVAL_DATE) }
            ]
          }
        } }
      ]
    } }]
  } };
  const received = receiveSourceSemantics(JSON.stringify(proposal), request, input);
  expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
  expect(received.interpretation).toBeDefined();
  return received.interpretation!;
}

type Constraints = { reporter?: string; reportDate?: string; approvalDate?: string };

function reportQuery(constraints: Constraints = {}) {
  const reporter = constraints.reporter ?? "Who";
  const reportDate = constraints.reportDate ?? "which reporting date";
  const approvalDate = constraints.approvalDate ?? "which approval date";
  const original = `${reporter} reported on ${reportDate} that Talia might approve grant G-8 on ${approvalDate}?`;
  const target = (key: string, excerpt: string, named: boolean) => ({ kind: named ? "named" : "free", key, excerpt, return: true });
  return { original, semantics: meaningQuery(original, [{
    kind: "statement", key: "report", predicate: "report", return: true, arguments: [
      { role: "reporter", target: target("reporter", reporter, constraints.reporter !== undefined) },
      { role: "time", target: target("reportedOn", reportDate, constraints.reportDate !== undefined) }
    ], content: { kind: "possible", key: "possibility", content: {
      kind: "statement", key: "approval", predicate: "approve", arguments: [
        { role: "approver", target: { kind: "named", key: "approver", excerpt: "Talia" } },
        { role: "item", target: { kind: "named", key: "grant", excerpt: "grant G-8" } },
        { role: "time", target: target("approvalOn", approvalDate, constraints.approvalDate !== undefined) }
      ]
    } }
  }]) };
}

function meaningQuery(original: string, conditions: object[]): SourceSemanticQuery {
  const semantics = materializeSourceSemanticQueryMeaning({
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions }], gaps: []
  }, { original_query: original, original_query_digest: digestOriginalQuery(original),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" });
  expect(admitSourceSemanticQuery(semantics, original).kind).toBe("admitted");
  return semantics;
}

function actualApprovalQuery(obligation: "asserted_at_source" | "entailed_at_source") {
  const original = `Did Talia approve grant G-8 on ${APPROVAL_DATE}?`;
  const semantics = meaningQuery(original, [{ kind: "statement", key: "approval", predicate: "approve", obligation, return: true,
    arguments: [
      { role: "approver", target: { kind: "named", key: "approver", excerpt: "Talia" } },
      { role: "item", target: { kind: "named", key: "grant", excerpt: "grant G-8" } },
      { role: "time", target: { kind: "named", key: "approvalOn", excerpt: APPROVAL_DATE } }
    ] }]);
  return { original, semantics };
}

function referentText(interpretation: SourceSemanticInterpretation, id: string): string {
  const referent = interpretation.referents.find(row => row.id === id);
  expect(referent).toBeDefined();
  return referent!.mentions.map(mention => interpretation.mentions.find(row => row.id === mention)!.text).join("|");
}

function correspond(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery): SourceSemanticCorrespondence {
  const correspondences: SourceSemanticCorrespondence["correspondences"][number][] = [];
  for (const queryFrame of semantics.alternatives[0]!.frames) {
    if (queryFrame.operator !== undefined) continue;
    const frame = interpretation.frames.find(row => row.predicate_support.reading === queryFrame.predicate_reading)!;
    expect(frame).toBeDefined();
    const predicateMentions = frame.predicate_support.kind === "explicit"
      ? frame.predicate_support.mentions : frame.predicate_support.supporting_context;
    correspondences.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
      source_endpoint: { kind: "frame", frame: frame.id },
      query_support: { kind: "query_text", excerpt: queryFrame.predicate_reading },
      source_semantic_support: [{ kind: "lexical", mentions: predicateMentions }] });
    for (const role of queryFrame.role_requirements) {
      const slot = frame.slots.find(row => row.role_reading === role.role_reading);
      if (slot === undefined) continue;
      correspondences.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: role.id },
        source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id },
        query_support: role.support, source_semantic_support: slot.support });
    }
  }
  // Named entities align to their literal evidence, independently of which event binds them.
  for (const variable of semantics.variables) {
    if (variable.reference === undefined) continue;
    const referent = interpretation.referents.find(row => referentText(interpretation, row.id) === variable.reference!.excerpt)!;
    expect(referent).toBeDefined();
    correspondences.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "referent", variable: variable.id },
      source_endpoint: { kind: "referent", referent: referent.id }, query_support: variable.reference,
      source_semantic_support: [{ kind: "lexical", mentions: referent.mentions }] });
  }
  return { contract: "source-semantic-correspondence-v3",
    source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256),
    query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1",
    contract_version: "source-semantic-correspondence-v3", correspondences };
}

function execute(interpretation: SourceSemanticInterpretation, query: ReturnType<typeof reportQuery>) {
  const correspondence = correspond(interpretation, query.semantics);
  expect(admitSourceSemanticCorrespondence({ source_interpretation: interpretation,
    query_semantics: query.semantics, semantic_correspondence: correspondence, original_query: query.original }).kind).toBe("admitted");
  // The shared fixture runs the native engine and independently checks exact bindings and proof leaves.
  const result = run(interpretation, query.semantics, correspondence, query.original);
  expect(result.outcome.status).toBe("interpreted");
  expect(result).toMatchObject({ semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
  return result;
}

describe("report event time and possible content time", () => {
  it("returns the report, reporter and distinct dates through source receive, query meaning and native matching", () => {
    const interpretation = interpretReport(), query = reportQuery();
    const report = interpretation.frames.find(row => row.predicate_support.reading === "report")!;
    const approval = interpretation.frames.find(row => row.predicate_support.reading === "approve")!;
    const possibility = interpretation.operators[0]!;
    expect(interpretation.operators.map(row => row.operator)).toEqual(["possible"]);
    expect(interpretation.asserted_at_scope).toEqual([report.id]);
    expect(possibility.context_owner).toEqual({ kind: "embedding", parent_frame: report.id, content_argument: possibility.id });
    expect(approval.context_owner).toEqual({ kind: "operator", operator_handle: possibility.id });
    const result = execute(interpretation, query);
    expect(result.binding_results).toHaveLength(1);
    const answer = result.binding_results![0]!;
    expect(answer.query_complete).toBe(true);
    expect(answer.returned.report?.node_id).toBe(report.id);
    expect(Object.fromEntries(["reporter", "reportedOn", "approvalOn"].map(key =>
      [key, referentText(interpretation, answer.returned[key]!.node_id)])))
      .toEqual({ reporter: "Omar", reportedOn: REPORT_DATE, approvalOn: APPROVAL_DATE });
    expect(answer.explanation_ids.length).toBeGreaterThan(0);
  });

  it.each([
    { name: "approval date as reporting date", constraints: { reportDate: APPROVAL_DATE } },
    { name: "reporting date as approval date", constraints: { approvalDate: REPORT_DATE } },
    { name: "approver as reporter", constraints: { reporter: "Talia" } }
  ])("does not satisfy $name through the other event's participants", ({ constraints }) => {
    expect(execute(interpretReport(), reportQuery(constraints)).binding_results).toEqual([]);
  });

  it("cannot satisfy the reporting date when that argument is omitted despite another date in the source", () => {
    expect(execute(interpretReport(false), reportQuery()).binding_results).toEqual([]);
  });

  it("does not promote possible approval to an asserted completed event", () => {
    expect(execute(interpretReport(), actualApprovalQuery("asserted_at_source")).binding_results).toEqual([]);
  });

  it("does not derive an entailed completed approval from possible report content", () => {
    const interpretation = interpretReport(), query = actualApprovalQuery("entailed_at_source");
    const correspondence = correspond(interpretation, query.semantics);
    // The relational fixture oracle covers assertion/context, not finite entailment.
    // Exercise that obligation at the same native runtime owner with an explicit no-answer expectation.
    const result = reasonSourceSemanticInterpretation({ source_interpretation: interpretation,
      query_semantics: query.semantics, semantic_correspondence: correspondence, original_query: query.original,
      workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK });
    expect(result.outcome.status).toBe("interpreted");
    expect(result.binding_results).toEqual([]);
  });
});
