import { expect } from "vitest";
import {
  sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  type SourceSemanticCorrespondence, type SourceSemanticEndpointCorrespondence,
  type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, receiveSourceSemantics } from "@do-soul/alaya-soul";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { admitSourceSemanticCorrespondence } from "../../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "../../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";
import { reasonSourceSemanticInterpretation } from "../../../../recall/runtime/source-semantic-reasoning.js";

export const CLASS_SOURCE = "I bought widgets and sold widgets last quarter.";
/** Hammer and mallet are non-widget objects here, not a claimed widget subtype. */
export const NONCLASS_SOURCE = "I bought the hammer and sold the mallet last quarter.";
export const CLOCK = "2026-09-18T00:00:00.000Z";

const atom = (text: string, occurrence?: number) => ({
  assertion_id: 1, text, ...(occurrence === undefined ? {} : { occurrence })
});
const entityRef = (key: string) => ({ kind: "entity_ref" as const, key });

function sourceInput(sourceCorpus: string) {
  return {
    sourceCorpus, assertionIds: [1], sourceScope: "complete-source" as const,
    source_id: "nominal-class-support", source_version: "1",
    producer_id: "authored-control", producer_version: "1"
  };
}

function eventTimeGap() {
  return {
    affected: [
      { kind: "occurrence_ref" as const, key: "buy" },
      { kind: "occurrence_ref" as const, key: "sell" }
    ],
    kind: "unsupported_meaning" as const,
    support: atom("last quarter"),
    description: "The source time window is not encoded as an executable event cutoff."
  };
}

type ExtraGap = {
  readonly affectedKeys: readonly string[];
  readonly supportText: string;
  readonly description: string;
};

function extraGapRows(extraGaps: readonly ExtraGap[]) {
  return extraGaps.map(gap => ({
    affected: gap.affectedKeys.map(key => ({ kind: "occurrence_ref" as const, key })),
    kind: "unsupported_meaning" as const,
    support: atom(gap.supportText),
    description: gap.description
  }));
}

function tableProposal(
  source: string, includeClass: boolean, classOnSameObject: boolean, speakerText: string, extraGaps: readonly ExtraGap[]
) {
  const boughtTheme = entityRef("bought");
  const soldTheme = entityRef("sold");
  const classBought = classOnSameObject ? boughtTheme : soldTheme;
  const classSold = classOnSameObject ? soldTheme : boughtTheme;
  const classNodes = includeClass ? [
    { kind: "statement" as const, key: "boughtKind",
      predicate: { kind: "implicit" as const, reading: "is a widget", support: atom("widgets", 0) },
      arguments: [{ role: "theme", target: classBought }], qualifications: [] },
    { kind: "statement" as const, key: "soldKind",
      predicate: { kind: "implicit" as const, reading: "is a widget", support: atom("widgets", 1) },
      arguments: [{ role: "theme", target: classSold }], qualifications: [] }
  ] : [];
  const widgetSource = source.includes("widgets");
  const entities = [
    { form: "entity" as const, key: "speaker", mentions: [atom(speakerText)] },
    { form: "entity" as const, key: "bought", mentions: [atom(widgetSource ? "widgets" : "hammer", widgetSource ? 0 : undefined)] },
    { form: "entity" as const, key: "sold", mentions: [atom(widgetSource ? "widgets" : "mallet", widgetSource ? 1 : undefined)] }
  ];
  return {
    contract: "source-semantic-proposal-v8" as const,
    outcome: { status: "interpreted" as const },
    content: {
      roots: [
        { act: "assertion" as const, expression: { kind: "content_ref" as const, key: "buy" } },
        { act: "assertion" as const, expression: { kind: "content_ref" as const, key: "sell" } },
        ...classNodes.map(node => ({ act: "assertion" as const, expression: { kind: "content_ref" as const, key: node.key } }))
      ],
      entities,
      nodes: [
        { kind: "statement" as const, key: "buy",
          predicate: { kind: "explicit" as const, reading: "buy", support: atom("bought") },
          arguments: [
            { role: "agent", target: entityRef("speaker") },
            { role: "theme", target: boughtTheme }
          ], qualifications: [] },
        { kind: "statement" as const, key: "sell",
          predicate: { kind: "explicit" as const, reading: "sell", support: atom("sold") },
          arguments: [
            { role: "agent", target: entityRef("speaker") },
            { role: "theme", target: soldTheme }
          ], qualifications: [] },
        ...classNodes
      ],
      gaps: [eventTimeGap(), ...extraGapRows(extraGaps)]
    }
  };
}

/** Authored capability-only table H; implicit class uses lexical noun support, not an explicit copula. */
export function receiveNominalClassInterpretation(input: {
  readonly source?: string;
  readonly includeClass?: boolean;
  readonly classOnSameObject?: boolean;
  readonly speakerText?: string;
  readonly extraGaps?: readonly ExtraGap[];
} = {}): SourceSemanticInterpretation {
  const source = input.source ?? CLASS_SOURCE;
  const includeClass = input.includeClass ?? true;
  const classOnSameObject = input.classOnSameObject ?? true;
  const speakerText = input.speakerText ?? "I";
  const extraGaps = input.extraGaps ?? [];
  const proposalInput = sourceInput(source);
  const received = receiveSourceSemantics(
    JSON.stringify(tableProposal(source, includeClass, classOnSameObject, speakerText, extraGaps)),
    buildSourceSemanticRequest(proposalInput),
    proposalInput
  );
  expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
  expect(received.interpretation).toBeDefined();
  return received.interpretation!;
}

function mentionText(interpretation: SourceSemanticInterpretation, id: string): string | undefined {
  return interpretation.mentions.find(row => row.id === id)?.text;
}

function predicateMentions(frame: SourceSemanticInterpretation["frames"][number]): readonly string[] {
  return frame.predicate_support.kind === "explicit"
    ? frame.predicate_support.mentions : frame.predicate_support.supporting_context;
}

function themeTarget(frame: SourceSemanticInterpretation["frames"][number]): string | undefined {
  const slot = frame.slots.find(row => row.role_reading === "theme");
  const binding = frame.bindings.find(row => row.slot_id === slot?.id);
  return binding?.target.kind === "node" ? binding.target.id : undefined;
}

function actionFrame(interpretation: SourceSemanticInterpretation, reading: "buy" | "sell") {
  return interpretation.frames.find(row => row.predicate_support.reading === reading);
}

function classFrameFor(interpretation: SourceSemanticInterpretation, action: SourceSemanticInterpretation["frames"][number]) {
  const object = themeTarget(action);
  return interpretation.frames.find(row => row.predicate_support.reading === "is a widget" && themeTarget(row) === object);
}

function endpoint(
  query: SourceSemanticEndpointCorrespondence["query_endpoint"],
  source: SourceSemanticEndpointCorrespondence["source_endpoint"],
  excerpt: string,
  mentions: readonly string[]
): SourceSemanticEndpointCorrespondence {
  return {
    relation: "contextual_equivalence",
    query_endpoint: query, source_endpoint: source,
    query_support: { kind: "query_text", excerpt },
    source_semantic_support: mentions.length === 0 ? [] : [{ kind: "lexical", mentions: [...mentions] }]
  };
}

export function nominalClassCorrespondence(input: {
  readonly interpretation: SourceSemanticInterpretation;
  readonly semantics: SourceSemanticQuery;
  readonly includeClass?: boolean;
  readonly classOnSameObject?: boolean;
}): SourceSemanticCorrespondence {
  const includeClass = input.includeClass ?? true;
  const classOnSameObject = input.classOnSameObject ?? true;
  const correspondences: SourceSemanticEndpointCorrespondence[] = [];
  const speaker = input.semantics.variables.find(row => row.id === "speaker");
  if (speaker?.reference !== undefined) {
    const mention = input.interpretation.mentions.find(row => row.text === speaker.reference!.excerpt);
    const referent = input.interpretation.referents.find(row => mention !== undefined && row.mentions.includes(mention.id));
    if (referent !== undefined) {
      correspondences.push(endpoint(
        { kind: "referent", variable: speaker.id },
        { kind: "referent", referent: referent.id },
        speaker.reference.excerpt,
        referent.mentions
      ));
    }
  }
  for (const queryFrame of input.semantics.alternatives[0]!.frames) {
    const isClass = queryFrame.predicate_reading === "is a widget";
    if (isClass && !includeClass) continue;
    const actionReading = queryFrame.id.startsWith("sell") ? "sell" as const : "buy" as const;
    const action = actionFrame(input.interpretation, actionReading);
    if (action === undefined) continue;
    const sourceFrame = isClass
      ? (classOnSameObject
        ? classFrameFor(input.interpretation, action!)
        : input.interpretation.frames.find(row =>
          row.predicate_support.reading === "is a widget" && themeTarget(row) !== themeTarget(action!)))
      : action;
    if (sourceFrame === undefined) continue;
    const excerpt = isClass ? "widgets" : queryFrame.predicate_reading;
    correspondences.push(endpoint(
      { kind: "predicate", alternative: 0, frame: queryFrame.id },
      { kind: "frame", frame: sourceFrame.id },
      excerpt,
      predicateMentions(sourceFrame)
    ));
    for (const role of queryFrame.role_requirements) {
      const slot = sourceFrame.slots.find(row => row.role_reading === role.role_reading);
      if (slot === undefined) continue;
      correspondences.push(endpoint(
        { kind: "slot", alternative: 0, frame: queryFrame.id, slot: role.id },
        { kind: "slot", frame: sourceFrame.id, slot: slot.id },
        role.support.excerpt,
        slot.support.flatMap(row => row.kind === "lexical" ? row.mentions : [])
      ));
    }
  }
  return {
    contract: "source-semantic-correspondence-v3",
    source_interpretation_id: sourceSemanticInterpretationIdentity(input.interpretation, fieldContractSha256),
    query_semantics_id: sourceSemanticQueryIdentity(input.semantics, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-correspondence-v3",
    correspondences
  };
}

export function admitNominalClassCorrespondence(input: {
  readonly interpretation: SourceSemanticInterpretation;
  readonly semantics: SourceSemanticQuery;
  readonly originalQuery: string;
  readonly correspondence?: SourceSemanticCorrespondence;
  readonly includeClass?: boolean;
  readonly classOnSameObject?: boolean;
}) {
  const correspondence = input.correspondence ?? nominalClassCorrespondence(input);
  return {
    correspondence,
    admission: admitSourceSemanticCorrespondence({
      source_interpretation: input.interpretation,
      query_semantics: input.semantics,
      semantic_correspondence: correspondence,
      original_query: input.originalQuery
    })
  };
}

export function reasonNominalClass(
  interpretation: SourceSemanticInterpretation,
  semantics: SourceSemanticQuery,
  correspondence: SourceSemanticCorrespondence,
  originalQuery: string
) {
  return reasonSourceSemanticInterpretation({
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    original_query: originalQuery, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK
  });
}

export function classSourceTexts(
  interpretation: SourceSemanticInterpretation,
  frameId: string | undefined
): readonly string[] {
  const frame = interpretation.frames.find(row => row.id === frameId);
  if (frame === undefined || frame.predicate_support.kind !== "implicit") return [];
  return predicateMentions(frame).map(id => mentionText(interpretation, id)).filter((text): text is string => text !== undefined);
}

export function lastQuarterGaps(interpretation: SourceSemanticInterpretation) {
  return interpretation.gaps.filter(row => row.kind === "unsupported_meaning" && row.support.some(support =>
    support.kind === "lexical" && support.mentions.some(id => mentionText(interpretation, id) === "last quarter")));
}

export function actionFrameIds(interpretation: SourceSemanticInterpretation): readonly string[] {
  return interpretation.frames.filter(row => row.predicate_support.reading === "buy" || row.predicate_support.reading === "sell").map(row => row.id);
}
