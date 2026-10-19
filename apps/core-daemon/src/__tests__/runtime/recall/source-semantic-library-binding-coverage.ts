import {
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, UNKNOWN_UTTERANCE_ATTRIBUTION, indexEntryCacheKey,
  sourceReferenceResolver, type SoulInterpretationResponse, type SourceReferenceCatalog,
  type SourceSemanticCorrespondence, type SourceSemanticLibraryProof, type SourceSemanticQuery,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, encodeSourceSemanticLibraryResponse, fieldContractSha256,
  semanticInterpretationEvidenceId, sourceGoldRootIdentity, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, type AccessFixtureSource } from "./source-semantic-access.test-support.js";

export const ORIGINAL = "which tools does Alice use?";
export const REQUIRED_LABELS = ["Pixel", "ThinkPad", "earbuds", "charger", "Kindle"] as const;
export const NON_TOOL_LABEL = "coffee" as const;
export const CLASS_READING = "is a tool" as const;
export const CLASS_NOUN = "tool" as const;
type ClassCorrespondence = "same_object" | "other_object" | "omitted";
export const OUTPUT_BYTE_LIMITS = {
  schema_min: 1024,
  test_small: 4096,
  test_capped: 8192,
  schema_max: 1_000_000
} as const;
export const PAYLOAD_TOKENS = 2_000;
/** Common library-recall fixture budget, not a proven public worker default. */
export const EXISTING_TEST_WORK_UNITS = 200_000;
export const FIXTURE_NOTES = [
  { id: "note-earbuds-run", label: "earbuds" },
  { id: "note-earbuds-bag", label: "earbuds" },
  { id: "note-charger-desk", label: "charger" },
  { id: "note-charger-bag", label: "charger" },
  { id: "note-kindle-train", label: "Kindle" },
  { id: "note-kindle-bag", label: "Kindle" },
  { id: "note-thinkpad-home", label: "ThinkPad" },
  { id: "note-thinkpad-bag", label: "ThinkPad" },
  { id: "note-pixel-desk", label: "Pixel" },
  { id: "note-coffee-cup", label: NON_TOOL_LABEL, kind: "non_tool" }
] as const;

export type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export type EncodedRecall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
type RecallRequest = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;

export function isNonToolNote(note: (typeof FIXTURE_NOTES)[number]): boolean {
  return "kind" in note && note.kind === "non_tool";
}

export function sentenceFor(label: string, kind?: "non_tool"): string {
  return kind === "non_tool" ? `Alice uses ${label}.` : `Alice uses ${label}, a tool.`;
}

export function bodyLabelFromSource(source_body: string | null): string {
  const classified = source_body?.match(/^Alice uses (.+), a tool\.$/);
  if (classified?.[1] !== undefined && classified[1].length > 0) return classified[1];
  const captured = source_body?.match(/^Alice uses (.+)\.$/);
  if (captured?.[1] === undefined || captured[1].length === 0) {
    throw new Error(`closed fixture source_body must be Alice-uses original: ${JSON.stringify(source_body)}`);
  }
  return captured[1];
}

export function bodyClassFromSource(source_body: string | null): typeof CLASS_NOUN | null {
  return source_body?.endsWith(", a tool.") === true ? CLASS_NOUN : null;
}

export function aliceUsesDraft(catalog: SourceReferenceCatalog, label: string, classH: ClassCorrespondence = "same_object") {
  const assertion = catalog.assertions.find((row) => row.assertion_id === 1) ?? catalog.assertions[0];
  if (assertion === undefined) throw new Error("catalog lacks assertions");
  const text = assertion.segments.map((part) => part.text).join("");
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const sourceRef = (name: string) => {
    const start = text.indexOf(name);
    if (start < 0) throw new Error(`catalog assertion lacks ${JSON.stringify(name)} in ${JSON.stringify(text)}`);
    return resolver.referenceForSpan(assertion.assertion_id, [start, start + name.length]);
  };
  const includeClass = classH === "same_object" || classH === "other_object";
  const classTheme = classH === "other_object" ? "rAlice" : "rTools";
  return {
    contract: "source-interpretation-v4" as const,
    mentions: [
      { id: "mAlice", assertion_id: assertion.assertion_id, source_ref: sourceRef("Alice") },
      { id: "mUses", assertion_id: assertion.assertion_id, source_ref: sourceRef("uses") },
      { id: "mTools", assertion_id: assertion.assertion_id, source_ref: sourceRef(label) },
      ...includeClass ? [{ id: "mClass", assertion_id: assertion.assertion_id, source_ref: sourceRef(CLASS_NOUN) }] : []
    ],
    referents: [
      { id: "rAlice", referent_kind: "grouped" as const, mentions: ["mAlice"] },
      { id: "rTools", referent_kind: "grouped" as const, mentions: ["mTools"] }
    ],
    frames: [{
      id: "fUse", assertion_ids: [1],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      additional_support: [],
      predicate_support: { kind: "explicit" as const, reading: "use", mentions: ["mUses"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mAlice"] }] },
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["mTools"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node" as const, id: "rAlice" }, support: [] },
        { slot_id: "theme", target: { kind: "node" as const, id: "rTools" }, support: [] }
      ]
    }, ...includeClass ? [{
      id: "fKind", assertion_ids: [1],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      additional_support: [],
      predicate_support: { kind: "implicit" as const, reading: CLASS_READING, supporting_context: ["mClass"] },
      slots: [
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["mTools"] }] }
      ],
      bindings: [
        { slot_id: "theme", target: { kind: "node" as const, id: classTheme }, support: [] }
      ]
    }] : []],
    operators: [],
    gaps: []
  };
}

export function fixtureSources(): AccessFixtureSource[] {
  return FIXTURE_NOTES.map((note) => ({
    id: note.id, text: sentenceFor(note.label, isNonToolNote(note) ? "non_tool" : undefined), verbatim: true as const,
    authoredDraft: (catalog: SourceReferenceCatalog) => aliceUsesDraft(catalog, note.label, isNonToolNote(note) ? "omitted" : "same_object")
  }));
}

export function queryOf(): SourceSemanticQuery {
  return {
    contract: "source-semantic-query-v4",
    original_query_digest: digestOriginalQuery(ORIGINAL),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1",
    contract_version: "source-semantic-query-v4",
    variables: [
      { id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
      { id: "tools", sort: "entity" },
      { id: "fUse", sort: "proposition" },
      { id: "fKind", sort: "proposition" }
    ],
    alternatives: [{
      frames: [{
        id: "qUse", variable: "fUse", predicate_reading: "use",
        role_requirements: [
          { id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "Alice" } },
          { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }
        ]
      }, {
        id: "qKind", variable: "fKind", predicate_reading: CLASS_READING,
        role_requirements: [
          { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }
        ]
      }],
      context_obligations: [
        { frame: "qUse", kind: "asserted_at_source" },
        { frame: "qKind", kind: "asserted_at_source" }
      ],
      answer_frames: [],
      evidence_inputs: [{ frames: ["qUse", "qKind"] }]
    }],
    return_variables: [],
    requested_operation: { reading: "enumerate", support: { kind: "query_text", excerpt: ORIGINAL } },
    gaps: [{
      kind: "aggregate",
      affected_ids: ["tools"],
      support: [{ kind: "query_text", excerpt: "which tools" }],
      description: "Complete tool enumeration is not executed; class-qualified use remains a local witness."
    }]
  };
}

function useCorrespondences(): SourceSemanticCorrespondence["correspondences"] {
  return [
    { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
      source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
      source_endpoint: { kind: "slot", frame: "fUse", slot: "agent" }, query_support: { kind: "query_text", excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
      source_endpoint: { kind: "frame", frame: "fUse" }, query_support: { kind: "query_text", excerpt: "use" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mUses"] }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "theme" },
      source_endpoint: { kind: "slot", frame: "fUse", slot: "theme" }, query_support: { kind: "query_text", excerpt: "tools" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mTools"] }] }
  ];
}

function classCorrespondences(): SourceSemanticCorrespondence["correspondences"] {
  return [
    { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qKind" },
      source_endpoint: { kind: "frame", frame: "fKind" }, query_support: { kind: "query_text", excerpt: "tools" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mClass"] }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qKind", slot: "theme" },
      source_endpoint: { kind: "slot", frame: "fKind", slot: "theme" }, query_support: { kind: "query_text", excerpt: "tools" },
      source_semantic_support: [{ kind: "lexical", mentions: ["mTools"] }] }
  ];
}

export function correspondenceOf(
  sourceInterpretationId: string, querySemantics: SourceSemanticQuery, classC: ClassCorrespondence = "same_object"
): SourceSemanticCorrespondence {
  const admitted = admitSourceSemanticQuery(querySemantics, ORIGINAL);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  const includeClass = classC === "same_object" || classC === "other_object";
  return {
    contract: "source-semantic-correspondence-v3",
    source_interpretation_id: sourceInterpretationId, query_semantics_id: admitted.query_id,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [...useCorrespondences(), ...includeClass ? classCorrespondences() : []]
  };
}

function classCorrespondenceFor(sourceId: string): ClassCorrespondence {
  const note = FIXTURE_NOTES.find((row) => row.id === sourceId);
  return note !== undefined && isNonToolNote(note) ? "omitted" : "same_object";
}

export function recallRequest(ids: ReadonlyMap<string, readonly string[]>, workUnits = ACCESS_BUDGET.work_units,
  outputByteLimit: RecallRequest["output_byte_limit"] = OUTPUT_BYTE_LIMITS.schema_max, options?: {
    query?: SourceSemanticQuery;
    classCorrespondence?: ClassCorrespondence | ((sourceId: string) => ClassCorrespondence);
  }): RecallRequest {
  const query = options?.query ?? queryOf();
  const classOf = options?.classCorrespondence;
  return {
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL, query_semantics: query,
    semantic_correspondences: [...ids.entries()].flatMap(([sourceId, interpretationIds]) => {
      const classC = typeof classOf === "function" ? classOf(sourceId)
        : classOf ?? classCorrespondenceFor(sourceId);
      return interpretationIds.map((interpretationId) => correspondenceOf(interpretationId, query, classC));
    }),
    budget: { ...ACCESS_BUDGET, work_units: workUnits }, output_byte_limit: outputByteLimit,
    access_policy: "query-conditioned-v1"
  };
}

export function encodeBytes(encoded: unknown): number {
  return Buffer.byteLength(JSON.stringify(encoded), "utf8");
}

export function namedLimitFits(bytes: number) {
  return Object.fromEntries(Object.entries(OUTPUT_BYTE_LIMITS).map(([name, limit]) => [name, {
    limit, fits: bytes <= limit, exact: bytes === limit, minus_one_fits: bytes <= limit - 1
  }]));
}

export function proofTools(proof: SourceSemanticLibraryProof | undefined): string[] {
  const values: string[] = [];
  for (const binding of proof?.binding_results ?? []) {
    const nodeId = (binding.returned?.tools ?? binding.bindings?.tools)?.node_id;
    const referent = proof?.interpretation.referents.find((row) => row.id === nodeId);
    for (const mentionId of referent?.mentions ?? []) {
      const text = proof?.interpretation.mentions.find((row) => row.id === mentionId)?.text;
      if (text !== undefined && text.length > 0) values.push(text);
    }
  }
  return [...new Set(values)];
}

export function proofClassTexts(proof: SourceSemanticLibraryProof | undefined): string[] {
  const values: string[] = [];
  for (const binding of proof?.binding_results ?? []) {
    const nodeId = binding.bindings?.fKind?.node_id;
    const frame = proof?.interpretation.frames.find((row) => row.id === nodeId);
    if (frame?.predicate_support.kind !== "implicit") continue;
    for (const mentionId of frame.predicate_support.supporting_context) {
      const text = proof?.interpretation.mentions.find((row) => row.id === mentionId)?.text;
      if (text !== undefined && text.length > 0) values.push(text);
    }
  }
  return [...new Set(values)];
}

export function pageLabels(recall: Recall): string[] {
  return [...new Set((recall.proofs ?? []).flatMap((proof) => proofTools(proof)))].sort();
}

export function pageRoots(recall: Recall): string[] {
  return recall.index.entries.flatMap((entry) => entry.target.kind === "source_evidence"
    ? [sourceGoldRootIdentity(entry.target)] : []);
}

export async function sqliteSources(filename: string) {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    return database.connection.prepare(
      "SELECT source_id, record_id, source_version, source_body, content_digest FROM source_records ORDER BY source_id"
    ).all() as { source_id: string; record_id: string; source_version: string; source_body: string | null; content_digest: string }[];
  } finally {
    database.close();
    closeCachedDatabase(filename);
  }
}

export async function publishedInterpretation(filename: string, interpretationId: string) {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const row = database.connection.prepare("SELECT gist FROM evidence_capsules WHERE object_id=?")
      .get(semanticInterpretationEvidenceId(interpretationId, fieldContractSha256, WS)) as { gist: string } | undefined;
    if (row === undefined) throw new Error(`missing published interpretation ${interpretationId}`);
    return JSON.parse(row.gist) as { interpretation: SourceSemanticLibraryProof["interpretation"] };
  } finally {
    database.close();
    closeCachedDatabase(filename);
  }
}

export function encodedRecall(encoded: SoulInterpretationResponse): EncodedRecall {
  if (encoded.operation !== "recall") throw new Error("encoded recall expected");
  return encoded;
}

export function encodedPage(recall: Recall): EncodedRecall {
  return encodedRecall(encodeSourceSemanticLibraryResponse(recall));
}

export { ACCESS_BUDGET, CLOCK, WS, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, indexEntryCacheKey, UNKNOWN_UTTERANCE_ATTRIBUTION };
