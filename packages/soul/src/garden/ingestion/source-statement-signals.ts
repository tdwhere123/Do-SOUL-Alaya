import { createHash } from "node:crypto";
import {
  SOURCE_STATEMENTS_CONTRACT, SourceStatementSignalSchema, LocatedSourceStatementSchema, RecordedSourceTimeSchema, canonicalJson,
  renderOfficialApiSourceCorpus, type SourceStatementReceipt, type SourceStatementMessage,
  type SourceStatementSignal, type ConversationMessage, type CandidateMemorySignal, type SourceStatementContextSource
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

export function emitSourceStatementSignals(input: Readonly<{
  receipt: SourceStatementReceipt; messages: readonly ConversationMessage[];
  artifactKey: string; sourceRootId: string; workspaceId: string; runId: string; surfaceId: string | null; createdAt: string;
  sourceObservation: CandidateMemorySignal["source_observation"];
  generateSignalId: () => string;
  sourceContexts?: ReadonlyMap<string, readonly SourceStatementContextSource[]>;
}>): readonly SourceStatementSignal[] {
  const source = sourceStatementSessionInput(input.messages);
  const digest = createHash("sha256").update(source.rendered.content, "utf8").digest("hex");
  const byId = new Map(source.messages.map((message, index) => [message.message_id, { message, index }]));
  return input.receipt.messages.flatMap(result => {
    const host = byId.get(result.message.message_id);
    if (host === undefined || canonicalJson(host.message) !== canonicalJson(result.message)) throw new TypeError("statement host binding changed");
    return result.statements.map(statement => SourceStatementSignalSchema.parse({
      signal_id: input.generateSignalId(), workspace_id: input.workspaceId, run_id: input.runId,
      surface_id: input.surfaceId, source: "garden_compile", signal_kind: "potential_semantic_observation",
      interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null,
      scope_hint: null, domain_tags: [], evidence_refs: [], source_memory_refs: [], supersedes_refs: [],
      exception_to_refs: [], contradicts_refs: [], incompatible_with_refs: [], created_at: input.createdAt,
      source_observation: input.sourceObservation,
      raw_payload: { source_statement: LocatedSourceStatementSchema.parse({
        contract: SOURCE_STATEMENTS_CONTRACT, session_id: input.receipt.session_id, artifact_key: input.artifactKey,
        source_root_id: input.sourceRootId, source_corpus_digest: digest, message: host.message,
        source_context: input.sourceContexts?.get(result.message.message_id) ?? [],
        source_span: source.rendered.occurrences[host.index]!.utf8_span, statement
      }) }
    }));
  });
}
