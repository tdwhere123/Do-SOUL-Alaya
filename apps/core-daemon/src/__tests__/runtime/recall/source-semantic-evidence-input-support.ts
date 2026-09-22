import { readFileSync } from "node:fs";
import { type QueryMeaning, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticCorrespondence, sourceSemanticInterpretationIdentity } from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { proposeSourceSemantics, proposeQuerySemantics } from "@do-soul/alaya-soul";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

export const COUNT = "How many different invited speakers actually spoke at Delta Forum on 2026-05-10?";
export const DURATION = "How many elapsed UTC days were there between Rana Sethi joining Larch Studio and her promotion there in June 2026?";
const rows: { input: Parameters<typeof proposeSourceSemantics>[0]; proposal: unknown }[] = JSON.parse(
  readFileSync(new URL("./source-semantic-evidence-input-fixture.json", import.meta.url), "utf8"));

export function authoredSource(name: string): SourceSemanticInterpretation {
  const row = rows.find(row => row.input.source_id === name)!;
  const received = proposeSourceSemantics(row.input, { rawJson: JSON.stringify(row.proposal) });
  if (received.interpretation === undefined) throw new Error(JSON.stringify(received.outcome));
  return received.interpretation;
}

type Argument = Extract<QueryMeaning, { kind: "statement" }>["arguments"][number];
const named = (role: string, key: string, excerpt: string): Argument => ({ role, target: { kind: "named", key, excerpt } });
const free = (role: string, key: string, excerpt: string, returned = false): Argument => ({
  role, target: { kind: "free", key, ...(returned ? { return: true } : {}) }, excerpt
});
const reference = (role: string, key: string, excerpt: string): Argument => ({ role, target: { kind: "reference", key }, excerpt });
const statement = (key: string, predicate: string, args: Argument[]): QueryMeaning => ({ kind: "statement", key, predicate, arguments: args });

export function evidenceQuery(kind: "count" | "duration", direct = true): SourceSemanticQuery {
  const original = kind === "count" ? COUNT : DURATION;
  const event = named("event", "event", "Delta Forum"), date = named("date", "event_date", "2026-05-10");
  const employee = named("employee", "employee", "Rana Sethi"), employer = named("employer", "employer", "Larch Studio");
  const answer = kind === "count" ? statement("answer", "exact count of different invited speakers who actually spoke at event", [
    free("count", "amount", "How many", true), named("population", "population", "different invited speakers"),
    named("actual participation", "participation", "actually spoke"), event, date
  ]) : statement("answer", "exact elapsed interval from joining employer to promotion there in calendar scope", [
    employee, employer, free("elapsed value", "amount", "How many", true), named("unit", "unit", "UTC days"),
    named("calendar scope", "calendar", "June 2026")
  ]);
  const inputs = kind === "count" ? [{ conditions: [
    statement("invited", "was invited speaker", [free("person", "person", "speakers"), event, date]),
    statement("spoke", "actually spoke", [reference("person", "person", "speakers"), event, date])
  ] }] : [
    { conditions: [statement("joining", "joined employer at timestamp", [employee, employer, free("timestamp", "joined_at", "joining")])] },
    { conditions: [statement("promotion", "was promoted at employer at timestamp in June 2026", [employee, employer,
      free("timestamp", "promoted_at", "promotion")])] }
  ];
  const received = proposeQuerySemantics({ original_query: original, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
    producer_version: "1" }, { rawJson: JSON.stringify({ contract: "source-semantic-query-response-v6", outcome: { status: "interpreted" },
    query: { contract: "source-semantic-query-meaning-v4", requested_operation: { reading: kind === "count"
      ? "count different invited speakers who actually spoke at the specified event and date"
      : "elapsed UTC days from joining to promotion in June 2026", support: { kind: "query_text", excerpt: original } },
    alternatives: [{ conditions: direct ? [answer] : [], evidence_inputs: inputs }], gaps: [] } }) });
  if (received.query === undefined) throw new Error(JSON.stringify(received.outcome));
  return received.query;
}

/** Authored equivalences for these frozen sources; open predicate interpretations remain producer work. */
export function authoredAlignment(source: SourceSemanticInterpretation, query: SourceSemanticQuery,
  original: string): SourceSemanticCorrespondence {
  const pairs: SourceSemanticCorrespondence["correspondences"][number][] = [];
  const references = new Set<string>();
  for (const [alternative, body] of query.alternatives.entries()) for (const frame of body.frames) {
    const reading = frame.id === "promotion" ? "was promoted at employer at timestamp" : frame.predicate_reading;
    for (const sourceFrame of source.frames.filter(row => row.predicate_support.reading === reading)) {
      pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative, frame: frame.id },
        source_endpoint: { kind: "frame", frame: sourceFrame.id }, query_support: { kind: "query_text", excerpt: original }, source_semantic_support: [] });
      for (const role of frame.role_requirements) {
        const slot = sourceFrame.slots.find(row => row.role_reading === role.role_reading)!;
        if (slot === undefined) throw new Error("Authored role does not exist in frozen source");
        pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative, frame: frame.id, slot: role.id },
          source_endpoint: { kind: "slot", frame: sourceFrame.id, slot: slot.id }, query_support: role.support, source_semantic_support: [] });
        const variable = query.variables.find(row => row.id === role.target_variable)!;
        const target = sourceFrame.bindings.find(row => row.slot_id === slot.id)!.target;
        if (variable.reference === undefined || target.kind !== "node") continue;
        const signature = JSON.stringify([variable.id, target.id]);
        if (references.has(signature)) continue;
        references.add(signature);
        pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: variable.id },
          source_endpoint: { kind: "referent", referent: target.id }, query_support: variable.reference, source_semantic_support: [] });
      }
    }
  }
  const received = receiveAuthoredCorrespondence({ original_query: original, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(source, fieldContractSha256),
      interpretation: source }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: pairs });
  if (received.semantic_correspondence === undefined) throw new Error(JSON.stringify(received.outcome));
  return received.semantic_correspondence;
}

export function mentionTexts(source: SourceSemanticInterpretation, referent: string): string[] {
  return source.referents.find(row => row.id === referent)!.mentions.map(id => source.mentions.find(row => row.id === id)!.text);
}
