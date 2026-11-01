import {
  SOURCE_STATEMENTS_CONTRACT, SourceStatementSignalSchema, LocatedSourceStatementSchema, RecordedSourceTimeSchema, canonicalJson,
  SourceStatementContextSourceSchema, renderOfficialApiSourceCorpus, type SourceStatementReceipt, type SourceStatementMessage,
  type SourceStatementRequest, type SourceStatementSignal, type ConversationMessage, type CandidateMemorySignal,
  type SourceStatementContextSource
} from "@do-soul/alaya-protocol";

/** Rendering owns byte boundaries; no role-marker parsing or model offsets. */
export function sourceStatementSessionInput(messages: readonly ConversationMessage[]) {
  const rendered = renderOfficialApiSourceCorpus("", messages);
  const bytes = Buffer.from(rendered.content, "utf8");
  return { rendered, messages: rendered.occurrences.map((occurrence): SourceStatementMessage => {
    const message = messages[occurrence.message_index]!;
    const time = message.created_at !== undefined || message.source_time === undefined
      ? undefined : RecordedSourceTimeSchema.parse(message.source_time);
    return { message_id: message.message_id, role: message.role, recorded_at: message.created_at ?? time?.normalized ?? null,
      text: bytes.subarray(...occurrence.utf8_span).toString("utf8"), ...(time === undefined ? {} : { recorded_time: time }) };
  }) };
}

/** An admitted source root holding session messages. A root seen as another target's context needs its version. */
export type SourceStatementRoot = Readonly<{
  root_id: string; source_id: string; content_digest: string; source_version?: string;
}>;
/** A session message at its exact host occurrence inside its own admitted root. */
export type LocatedSourceStatementMessage = Readonly<{
  message: SourceStatementMessage; root: SourceStatementRoot; utf8_span: readonly [number, number];
}>;

/** One statement session publishes to each message's own root. Context dependencies are the other roots
 * the model saw in that target's request, never unseen future chunks.
 */
export function emitSourceStatementSessionSignals(input: Readonly<{
  receipt: SourceStatementReceipt; requests: readonly SourceStatementRequest[];
  located: readonly LocatedSourceStatementMessage[];
  workspaceId: string; runId: string; surfaceId: string | null; createdAt: string;
  sourceObservation: CandidateMemorySignal["source_observation"];
  generateSignalId: () => string;
}>): readonly SourceStatementSignal[] {
  const located = new Map<string, LocatedSourceStatementMessage>();
  for (const row of input.located) {
    if (located.has(row.message.message_id)) throw new TypeError("duplicate located session message");
    located.set(row.message.message_id, row);
  }
  const host = (message: SourceStatementMessage) => {
    const row = located.get(message.message_id);
    if (row === undefined || canonicalJson(row.message) !== canonicalJson(message)) throw new TypeError("statement host binding changed");
    return row;
  };
  const contexts = new Map<string, readonly SourceStatementContextSource[]>();
  for (const request of input.requests) {
    if (request.session_id !== input.receipt.session_id) throw new TypeError("statement request belongs to another session");
    const roots = new Map<string, SourceStatementRoot>();
    for (const message of [...request.context, ...request.messages]) roots.set(host(message).root.root_id, host(message).root);
    for (const target of request.messages) {
      const own = host(target).root.root_id;
      contexts.set(target.message_id, [...roots.values()].filter(root => root.root_id !== own)
        .map(root => SourceStatementContextSourceSchema.parse({ workspace_id: input.workspaceId, root_id: root.root_id,
          source_id: root.source_id, source_version: root.source_version, content_digest: root.content_digest })));
    }
  }
  return input.receipt.messages.flatMap(result => {
    const row = host(result.message), context = contexts.get(result.message.message_id);
    // Raw fallbacks (oversize messages) have no request; only generated statements need one.
    if (context === undefined && result.statements.length > 0) throw new TypeError("statement target is outside its planned request");
    return result.statements.map(statement => SourceStatementSignalSchema.parse({
      signal_id: input.generateSignalId(), workspace_id: input.workspaceId, run_id: input.runId,
      surface_id: input.surfaceId, source: "garden_compile", signal_kind: "potential_semantic_observation",
      interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null,
      scope_hint: null, domain_tags: [], evidence_refs: [], source_memory_refs: [], supersedes_refs: [],
      exception_to_refs: [], contradicts_refs: [], incompatible_with_refs: [], created_at: input.createdAt,
      source_observation: input.sourceObservation,
      raw_payload: { source_statement: LocatedSourceStatementSchema.parse({
        contract: SOURCE_STATEMENTS_CONTRACT, session_id: input.receipt.session_id, artifact_key: row.root.source_id,
        source_root_id: row.root.root_id, source_corpus_digest: corpusDigest(row.root.content_digest), message: row.message,
        source_context: context ?? [], source_span: row.utf8_span, statement
      }) }
    }));
  });
}

function corpusDigest(contentDigest: string): string {
  if (!contentDigest.startsWith("sha256:")) throw new TypeError("statement root digest must be a sha256 content digest");
  return contentDigest.slice("sha256:".length);
}
