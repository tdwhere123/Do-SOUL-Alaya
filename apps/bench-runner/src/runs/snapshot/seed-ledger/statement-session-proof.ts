import { canonicalJson, type ConversationMessage, type SourceStatementReceipt } from "@do-soul/alaya-protocol";
import { assertSourceStatementSessionReceipt, SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";
import { inspectExtractionRawJson } from "../../extraction/content-closure.js";
import { sourceStatementSession } from "../../extraction/source-statement-request.js";
import type { LongMemEvalSnapshotSeedRound } from "../materialize.js";
import type { CompleteExtraction } from "./seed-ledger-shared.js";

type Shards = NonNullable<LongMemEvalSnapshotSeedRound["extractionShards"]>;
export interface VerifiedStatementSession {
  readonly receiptJson: string;
  readonly shards: Shards;
}

/** Current statement receipts are proven from retained bytes, not relabeled legacy counts. */
export function assertStatementRound(input: {
  readonly round: LongMemEvalSnapshotSeedRound;
  readonly sessionMessages: readonly ConversationMessage[];
  readonly roundMessages: readonly ConversationMessage[];
  readonly extraction: CompleteExtraction;
  readonly seen: Map<string, VerifiedStatementSession>;
}): void {
  const { round, extraction } = input;
  const record = round.statementSession;
  if (record === undefined) throw new Error("snapshot statement session receipt is missing");
  const source = sourceStatementSession(input.sessionMessages);
  const receiptJson = canonicalJson(record.receipt);
  let verified = input.seen.get(source.sessionId);
  if (record.firstUse !== (verified === undefined)) throw new Error("statement session first-use accounting differs");
  if (verified === undefined) {
    if (record.responses === undefined) throw new Error("statement session response bytes are missing");
    assertSourceStatementSessionReceipt({ session_id: source.sessionId, messages: source.messages,
      receipt: record.receipt, responses: record.responses });
    const shards = record.responses.map(response => {
      const counts = inspectExtractionRawJson(response.rawJson, { sourceAssertionCount: response.request.messages.length,
        sourceStatementRequest: response.request, planMembership: "in_plan" });
      return { cacheKey: computeCacheKey(extraction.extraction_model, extraction.request_profile,
        SOURCE_STATEMENTS_PROMPT, JSON.stringify(response.request)), rawJsonSha256: counts.rawJsonSha256,
        rawSignalCount: counts.rawSignalCount, draftCount: counts.parsedDraftCount };
    });
    verified = { receiptJson, shards };
    input.seen.set(source.sessionId, verified);
  } else if (record.responses !== undefined || receiptJson !== verified.receiptJson) {
    throw new Error("statement session replay changes its original receipt");
  }
  if (canonicalJson(round.extractionShards) !== canonicalJson(verified.shards) ||
      (round.semanticSupplementShards?.length ?? 0) !== 0) throw new Error("statement session shard identity differs");
  const ids = new Set(input.roundMessages.map(message => message.message_id));
  const selected = record.receipt.messages.filter(result => ids.has(result.message.message_id));
  if (selected.length !== ids.size) throw new Error("statement round lacks its host messages");
  const accepted = selected.reduce((sum, result) => sum + result.statements.length, 0);
  const unassigned = Math.max(0, verified.shards.reduce((sum, shard) => sum + shard.rawSignalCount, 0) -
    record.receipt.messages.reduce((sum, result) => sum + result.statements.length, 0) - rejectedStatements(record.receipt.messages));
  const raw = accepted + rejectedStatements(selected) + (record.firstUse ? unassigned : 0);
  const single = verified.shards.length === 1 ? verified.shards[0] : undefined;
  if (record.unassignedRawStatements !== unassigned || round.rawSignalCount !== raw || round.draftCount !== accepted ||
      round.extractionSource !== (verified.shards.length === 0 ? "fallback" : "cache") ||
      round.cacheKey !== (single?.cacheKey ?? null) || round.rawJsonSha256 !== (single?.rawJsonSha256 ?? null)) {
    throw new Error("statement round projection or request accounting differs");
  }
}

function rejectedStatements(messages: SourceStatementReceipt["messages"]): number {
  return messages.reduce((sum, result) => sum + result.rejections.filter(rejection => rejection.statement_index !== null).length, 0);
}
