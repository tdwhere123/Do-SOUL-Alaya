import { canonicalJson, renderOfficialApiSourceCorpus, type ConversationMessage,
  type SourceStatementContextSource } from "@do-soul/alaya-protocol";
import { deriveAddressableSpanViews, retainedSourceSpeaker } from "@do-soul/alaya-core";
import { sourceStatementRequests } from "../extraction/source-statement-request.js";
import { ExtractionCacheInvariantError } from "../extraction/cache/cache-invariant-error.js";
import type { CompileSeedTurnInput } from "./compile-seed-types.js";

export interface CapturedStatementSourceSession {
  readonly partition: string;
  readonly observedAt: string;
  readonly bySeed: ReadonlyMap<number, SourceStatementContextSource>;
  readonly byMessage: ReadonlyMap<string, SourceStatementContextSource>;
}

/** Admit the existing raw partition before dispatch: later targets are model-visible too.
 * No session-sized SourceIndex root is introduced, and extraction does not choose the raw partition.
 */
export async function captureStatementSourceSession(input: CompileSeedTurnInput,
  captures: Map<string, Promise<CapturedStatementSourceSession>>): Promise<CapturedStatementSourceSession> {
  const messages = input.sourceSession ?? input.turnMessages ?? [];
  const rounds = input.sourceSessionRounds ?? [{ seedIndex: input.seedIndex,
    turnContent: input.turnContent, turnMessages: input.turnMessages ?? [] }];
  if (canonicalJson(rounds.flatMap(round => round.turnMessages)) !== canonicalJson(messages) ||
      new Set(rounds.map(round => round.seedIndex)).size !== rounds.length) {
    throw new ExtractionCacheInvariantError("session source partition must preserve every message in order");
  }
  const own = rounds.find(round => round.seedIndex === input.seedIndex);
  if (own === undefined || canonicalJson(own.turnMessages) !== canonicalJson(input.turnMessages ?? [])) {
    throw new ExtractionCacheInvariantError("seed round differs from its captured raw partition");
  }
  const partition = canonicalJson({ rounds, sourceObservedAt: input.sourceObservedAt ?? null });
  const key = canonicalJson([input.workspaceId, input.runId, rounds.map(round => round.seedIndex)]);
  let pending = captures.get(key);
  if (pending === undefined) { pending = admitRawRounds(input, rounds, partition); captures.set(key, pending); }
  const captured = await pending;
  if (captured.partition !== partition) throw new ExtractionCacheInvariantError("session raw partition changed during seeding");
  return captured;
}

async function admitRawRounds(input: CompileSeedTurnInput, rounds: NonNullable<CompileSeedTurnInput["sourceSessionRounds"]>,
  partition: string): Promise<CapturedStatementSourceSession> {
  const bySeed = new Map<number, SourceStatementContextSource>(), byMessage = new Map<string, SourceStatementContextSource>();
  const observedAt = input.sourceObservedAt ?? new Date().toISOString();
  for (const round of rounds) {
    const rendered = renderOfficialApiSourceCorpus(round.turnContent.trim(), round.turnMessages);
    const speaker = retainedSourceSpeaker(round.turnMessages.map(message => message.role));
    const admitted = await input.daemon.importSourceRecord({
      source_id: `compile-seed:${input.workspaceId}:${input.runId}:${round.seedIndex}`, source_version: "1",
      content_bytes: rendered.content, recorded_at: observedAt, event_time: input.sourceObservedAt ?? null,
      valid_from: null, valid_to: null, scope_class: "project", ...(speaker === undefined ? {} : { speaker }),
      spans: deriveAddressableSpanViews(rendered.content), host_occurrences: rendered.occurrences.map(occurrence => ({
        occurrence_id: round.turnMessages[occurrence.message_index]!.message_id, utf8_span: occurrence.utf8_span,
        role: round.turnMessages[occurrence.message_index]!.role, channel: null, author_ref: null, container_ref: null,
        upstream_message_ref: null, upstream_position: null, completeness: "complete", fidelity: occurrence.fidelity
      }))
    }, request => ({ namespace: "bench-conversation-seed", workspace_id: request.workspace_id,
      producer: "compile-seed", basis: "pinned_dataset" }));
    const record = admitted.record;
    const source: SourceStatementContextSource = { workspace_id: record.workspace_id, root_id: record.identity,
      source_id: record.source_id, source_version: record.source_version, content_digest: record.content_digest };
    bySeed.set(round.seedIndex, source);
    for (const message of round.turnMessages) {
      if (byMessage.has(message.message_id)) throw new ExtractionCacheInvariantError("raw session message is duplicated");
      byMessage.set(message.message_id, source);
    }
  }
  return { partition, observedAt, bySeed, byMessage };
}

/** Only actual request context and targets contribute dependencies, never unseen future chunks. */
export function statementRequestSourceContexts(messages: readonly ConversationMessage[], captured: CapturedStatementSourceSession) {
  const contexts = new Map<string, readonly SourceStatementContextSource[]>();
  for (const { source: request } of sourceStatementRequests(messages)) {
    const roots = new Map<string, SourceStatementContextSource>();
    for (const message of [...request.context, ...request.messages]) {
      const source = captured.byMessage.get(message.message_id);
      if (source === undefined) throw new ExtractionCacheInvariantError("model-visible message has no captured raw root");
      roots.set(source.root_id, source);
    }
    for (const target of request.messages) {
      const own = captured.byMessage.get(target.message_id)!;
      contexts.set(target.message_id, [...roots.values()].filter(source => source.root_id !== own.root_id));
    }
  }
  return contexts;
}
