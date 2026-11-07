import {
  buildSourceReferenceCatalog, sourceReferenceResolver, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SourceSemanticQuerySchema, sourceSemanticCorrespondenceIdentity,
  type SourceSemanticFrame, type SourceSemanticMention, type SourceSemanticReferent,
  type SourceTaskAssociation
} from "@do-soul/alaya-protocol";
import { createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createSourceSemanticPublication } from "../../../runtime/field/source-semantic-publication.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { CLOCK, WS, digest, type IndexFixture } from "./source-semantic-index-acquisition.test-support.js";

type AuthoredFrame = Readonly<{ id: string; text: string; predicate: string;
  roles: readonly Readonly<{ id: string; text: string; unresolved?: boolean; unexpressed?: boolean }>[] }>;

/** Authored legal Q/H/C through the production publication and correspondence owners. */
export async function selectedTaskSource(fixture: IndexFixture, input: Readonly<{
  sourceId: string; body: string; observedAt: string; query: string;
  frames: readonly AuthoredFrame[]; selectedFrame: string;
  roles: readonly Readonly<{ id: string; queryExcerpt: string; named?: boolean }>[];
  evidence?: boolean; temporalSlot?: string;
}>) {
  const stores = createSqliteFieldFormationStores({ database: fixture.database,
    repos: createDaemonFieldRepos({ database: fixture.database }) });
  const eventLogRepo = new SqliteEventLogRepo(fixture.database), runtimeNotifier = { notifyEntry: async () => undefined };
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(fixture.database), now: () => CLOCK });
  const publication = createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 });
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(input.body), [{ assertion_id: 1, text: input.body }], fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const mentions: SourceSemanticMention[] = [], referents: SourceSemanticReferent[] = [];
  const frames: SourceSemanticFrame[] = [];
  for (const frame of input.frames) {
    const start = input.body.indexOf(frame.text);
    if (start < 0 || input.body.indexOf(frame.text, start + 1) >= 0) throw new Error("authored frame requires one exact source occurrence");
    const mention = (id: string, text: string) => {
      const local = frame.text.indexOf(text);
      if (local < 0 || frame.text.indexOf(text, local + 1) >= 0) throw new Error("authored operand requires one exact frame occurrence");
      mentions.push({ id, assertion_id: 1, source_ref: resolver.referenceForSpan(1, [start + local, start + local + text.length]) });
      return id;
    };
    const predicate = mention(`${frame.id}Predicate`, frame.predicate);
    const roles = frame.roles.map(role => {
      const id = `${frame.id}${role.id}`;
      const m = role.unexpressed ? undefined : mention(`${id}Mention`, role.text);
      referents.push({ id, referent_kind: role.unexpressed ? "unexpressed" : "grouped", mentions: m === undefined ? [] : [m] });
      return { role, id, m };
    });
    frames.push({ id: frame.id, assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: frame.predicate, mentions: [predicate] },
      slots: roles.map(({ role, m }) => ({ id: role.id, role_reading: role.id,
        support: m === undefined ? [] : [{ kind: "lexical", mentions: [m] }] })),
      bindings: roles.map(({ role, id }) => ({ slot_id: role.id,
        target: role.unresolved ? { kind: "unresolved" } : { kind: "node", id }, support: [] })) });
  }
  const published = await publication.publish({ workspaceId: WS, runId: "run-1", artifactKey: input.sourceId,
    source: input.body, catalog, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    provenance: { producer_id: "authored-source-task" }, producer_version: "1", contract_version: "source-interpretation-v4",
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(input.body)] }],
    draft: { contract: "source-interpretation-v4", frames, mentions, referents, operators: [], gaps: [] } });
  const h = published.bound.interpretation;
  const sourceFrame = h.frames.find(frame => frame.id === input.selectedFrame)!;
  if (sourceFrame === undefined) throw new Error("selected authored frame is absent");
  const semantics = SourceSemanticQuerySchema.parse({ contract: "source-semantic-query-v4",
    original_query_digest: digest(input.query), approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [{ id: "event", sort: "proposition" }, ...input.roles.map(role => ({ id: role.id, sort: "entity",
      ...(role.named ? { reference: { kind: "query_text", excerpt: role.queryExcerpt } } : {}) }))],
    alternatives: [{ frames: [{ id: "task", variable: "event", predicate_reading: sourceFrame.predicate_support.reading,
      role_requirements: input.roles.map(role => ({ id: role.id, role_reading: role.id, target_variable: role.id,
        support: { kind: "query_text", excerpt: role.queryExcerpt } })) }],
      context_obligations: [{ frame: "task", kind: "asserted_at_source" }],
      ...(input.evidence ? { answer_frames: [], evidence_inputs: [{ frames: ["task"] }] } : {}) }],
    return_variables: input.evidence ? [] : input.roles.filter(role => !role.named).map(role => role.id), gaps: [],
    ...(input.evidence ? { requested_operation: { reading: input.query, support: { kind: "query_text", excerpt: input.query } } } : {}) });
  const pairs: object[] = [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "task" },
    source_endpoint: { kind: "frame", frame: sourceFrame.id }, query_support: { kind: "query_text", excerpt: input.query },
    source_semantic_support: [] }];
  for (const role of input.roles) {
    pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "task", slot: role.id },
      source_endpoint: { kind: "slot", frame: sourceFrame.id, slot: role.id },
      query_support: { kind: "query_text", excerpt: role.queryExcerpt }, source_semantic_support: [] });
    if (role.named) pairs.push({ relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: role.id },
      source_endpoint: { kind: "referent", referent: `${sourceFrame.id}${role.id}` },
      query_support: { kind: "query_text", excerpt: role.queryExcerpt }, source_semantic_support: [] });
  }
  const c = receiveAuthoredCorrespondence({ original_query: input.query, admitted_query_semantics: semantics,
    source_interpretation_descriptors: [{ source_interpretation_id: published.bound.interpretation_id, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: pairs });
  if (c.semantic_correspondence === undefined) throw new Error(JSON.stringify(c.outcome));
  const association: SourceTaskAssociation = { semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(c.semantic_correspondence,
    fieldContractSha256), alternative: 0, target: input.evidence ? { kind: "evidence", input: 0 } : { kind: "answer" },
    query_frame: "task", source_frame: sourceFrame.id,
    ...(input.temporalSlot === undefined ? {} : { temporal_operand: { kind: "slot", frame: sourceFrame.id, slot: input.temporalSlot } }) };
  return { withdraw: () => createSourceSemanticPublication({ database: fixture.database, evidenceService }).invalidate!({ request: { workspace_id: WS, run_id: "run-1",
      source_interpretation_id: published.bound.interpretation_id,
      source: { source_id: input.sourceId, source_version: "1", content_digest: published.bound.source_target.content_digest },
      error_basis: { reason: "Authored interpretation withdrawal.", basis_ref: "source-review" },
      provenance: { reporter_id: "local-reviewer" }, authorized_scopes: { mode: "named", scopes: ["project"] } },
      budget: { schema_version: 1, work_units: 2_000_000, memory_bytes: 32_000_000,
        page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 } }),
    selection: { query_semantics: semantics, semantic_correspondences: [c.semantic_correspondence] },
    source: { source_ref: "source1", target: published.bound.source_target, source_observed_at: input.observedAt,
      body: input.body, association, selected_interpretation: published.bound } };
}
