import {
  canonicalJson, sourceReferenceResolver, sourceSemanticQueryIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceReferenceCatalog, type SourceSemanticQuery, type SourceSemanticCorrespondence,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary, type AccessFixtureSource } from "./source-semantic-access.test-support.js";

export const ORIGINAL = "Which ticket does M7 use?";
export const CHILD = { ...ACCESS_BUDGET, work_units: 200_000, memory_bytes: 4_000_000 };
export const CONTEXT = { workspace_id: WS, as_of: CLOCK, principal: "feedback-principal",
  authorized_scopes: { mode: "named" as const, scopes: ["project"] } };
export type Reason = Extract<SourceSemanticWorkerResult, { kind: "reason" }>;

function draft(catalog: SourceReferenceCatalog, ticket: string) {
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const text = catalog.assertions[0]!.segments.map(row => row.text).join("");
  const mention = (id: string, value: string) => ({ id, assertion_id: 1,
    source_ref: resolver.referenceForSpan(1, [text.indexOf(value), text.indexOf(value) + value.length]) });
  return { contract: "source-interpretation-v4", mentions: [mention("mM7", "M7"), mention("mUse", "uses"), mention("mTicket", ticket)],
    referents: [{ id: "rM7", referent_kind: "grouped", mentions: ["mM7"] },
      { id: "rTicket", referent_kind: "grouped", mentions: ["mTicket"] }],
    frames: [{ id: "fUse", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [], predicate_support: { kind: "explicit", reading: "use", mentions: ["mUse"] },
      slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mM7"] }] },
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical", mentions: ["mTicket"] }] }],
      bindings: [{ slot_id: "agent", target: { kind: "node", id: "rM7" }, support: [] },
        { slot_id: "theme", target: { kind: "node", id: "rTicket" }, support: [] }] }], operators: [], gaps: [] };
}
export function query(): SourceSemanticQuery {
  return { contract: "source-semantic-query-v4", original_query_digest: digestOriginalQuery(ORIGINAL),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [{ id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "M7" } },
      { id: "ticket", sort: "entity" }, { id: "use", sort: "proposition" }],
    alternatives: [{ frames: [{ id: "qUse", variable: "use", predicate_reading: "use",
      role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "M7" } },
        { id: "theme", role_reading: "theme", target_variable: "ticket", support: { kind: "query_text", excerpt: "ticket" } }] }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] }], return_variables: ["ticket"], gaps: [] };
}
function correspondence(id: string, q = query()): SourceSemanticCorrespondence {
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: id,
    query_semantics_id: sourceSemanticQueryIdentity(q, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [
      { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
        source_endpoint: { kind: "referent", referent: "rM7" }, query_support: { kind: "query_text", excerpt: "M7" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mM7"] }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
        source_endpoint: { kind: "frame", frame: "fUse" }, query_support: { kind: "query_text", excerpt: "use" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mUse"] }] },
      ...(["agent", "theme"] as const).map(slot => ({ relation: "contextual_equivalence" as const,
        query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot },
        source_endpoint: { kind: "slot" as const, frame: "fUse", slot },
        query_support: { kind: "query_text" as const, excerpt: slot === "agent" ? "M7" : "ticket" },
        source_semantic_support: [{ kind: "lexical" as const, mentions: [slot === "agent" ? "mM7" : "mTicket"] }] }))
    ] };
}

export async function withFeedbackSource(ticket: string, body: (input: {
  client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>; session: SourceFeedbackSessionInput; native: Reason; filename: string;
  ids: ReadonlyMap<string, readonly string[]>;
}) => Promise<void>, options?: { original_query: string; query: SourceSemanticQuery; provider_guard?: URL;
  additional_sources?: readonly AccessFixtureSource[]; approval_ticket?: string; interpretation_census?: "complete" }) {
  const guard = `--import=${(options?.provider_guard ?? new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url)).href}`;
  process.execArgv.push(guard);
  try {
    await withAccessLibrary([
      { id: "a", text: `M7 uses ${ticket}.`, verbatim: true, authoredDraft: catalog => draft(catalog, ticket) },
      ...(options?.additional_sources ?? []),
      { id: "middle", text: "Granite ".repeat(1000), reading: "surround", count: 40 },
      { id: "z", text: `${options?.approval_ticket ?? ticket} approval by Rina.`, reading: "approval" }
    ], async ({ filename, ids }) => {
      const { database } = await createRecallRealStorage(() => undefined, filename);
      // Census walks logical source_id, not the persisted record root. Oversized metadata on
      // filler `middle` stops before `z`; bloating accepted M7 (`a`) makes its current record unreadable.
      database.connection.prepare("UPDATE source_records SET operator_id=? WHERE source_id='middle'").run("x".repeat(9000));
      database.connection.prepare("UPDATE evidence_capsules SET created_at=? WHERE source_hash IN (SELECT content_digest FROM source_records WHERE source_id='z')")
        .run("2026-09-19T00:00:00.000Z");
      // Interpretation headers have an independent census, so the raw-source stopper alone
      // leaves z reachable according to digest-derived capsule verification order. An oversized
      // middle timestamp sorts after a and before z, stopping that census without changing the
      // FTS route through which the accepted ticket binding must discover z.
      if (options?.interpretation_census !== "complete") {
        database.connection.prepare("UPDATE evidence_capsules SET created_at=? WHERE source_hash IN (SELECT content_digest FROM source_records WHERE source_id='middle')")
          .run(`${CLOCK}${"x".repeat(65)}`);
      }
      database.close(); closeCachedDatabase(filename);
      const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
      try {
        await client.ready();
        const seed = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
          original_query: options?.original_query ?? ORIGINAL, source_interpretation_id: ids.get("a")![0]!, query_semantics: options?.query ?? query(),
          semantic_correspondence: correspondence(ids.get("a")![0]!, options?.query), budget: CHILD, output_byte_limit: 1_000_000 };
        const native = await client.sourceSemanticsPort!.execute({ ...CONTEXT, request: seed });
        if (native.kind !== "reason" || native.result?.source_target === undefined) throw new Error("native bound result required");
        await body({ client, native, filename, ids, session: { request_id: "root-request", parent_entitlement_id: "root-allowance",
          workspace_id: WS, source_id: "a", source_target: native.result.source_target,
          scope_identity: canonicalJson([CONTEXT.principal, CONTEXT.authorized_scopes]), as_of: CLOCK, original_query: options?.original_query ?? ORIGINAL,
          seed, budget: { ...CHILD, work_units: 1_000_000, memory_bytes: 20_000_000 }, action_budget: CHILD } });
      } finally { await client.close(); }
    });
  } finally { process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1); }
}
