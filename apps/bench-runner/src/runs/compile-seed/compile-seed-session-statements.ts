import { randomUUID } from "node:crypto";
import type { ConversationMessage, SourceStatementReceipt, SourceStatementContextSource } from "@do-soul/alaya-protocol";
import { emitSourceStatementSignals, OfficialApiGardenCompileIncompleteError,
  type GardenCompileContext, type OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { sourceStatementSession } from "../extraction/source-statement-request.js";
import { ExtractionCacheInvariantError } from "../extraction/cache/cache-invariant-error.js";
import type { CompileSeedExtractionStats, StatementSessionSeedResponse } from "./compile-seed-types.js";

export interface CompiledStatementSession {
  readonly receipt: SourceStatementReceipt;
  readonly source: CompileSeedExtractionStats["lastExtractionSource"];
  readonly shards: NonNullable<CompileSeedExtractionStats["lastExtractionShards"]>;
  readonly rawCount: number;
  readonly singleRequestCacheKey: string | null;
  readonly responses: readonly StatementSessionSeedResponse[];
  readonly failure?: OfficialApiGardenCompileIncompleteError;
}

/** One settled session feeds each raw round. Failed requests stay failed in this run;
 * publication retries reuse the receipt, never dispatch another extraction.
 */
export async function compileSessionSeedSignals(input: {
  readonly provider: OfficialApiGardenProvider;
  readonly sessions: Map<string, Promise<CompiledStatementSession>>;
  readonly context: GardenCompileContext;
  readonly sourceSession: readonly ConversationMessage[];
  readonly sourceContexts: ReadonlyMap<string, readonly SourceStatementContextSource[]>;
  readonly stats: CompileSeedExtractionStats;
}) {
  const source = sourceStatementSession(input.sourceSession), { context, stats } = input;
  if (context.artifact_key === undefined || context.source_root_id === undefined) {
    throw new ExtractionCacheInvariantError("statement seeding requires an admitted raw round");
  }
  let pending = input.sessions.get(source.sessionId);
  const firstUse = pending === undefined;
  if (pending === undefined) {
    pending = extractSession(input, source.sessionId);
    input.sessions.set(source.sessionId, pending);
  }
  const compiled = await pending;
  const ids = new Set(context.turn_messages.map(message => message.message_id));
  const messages = compiled.receipt.messages.filter(result => ids.has(result.message.message_id));
  if (messages.length !== ids.size) throw new ExtractionCacheInvariantError("seed round is outside its captured session");
  const accepted = messages.reduce((sum, result) => sum + result.statements.length, 0);
  const statementRejections = (receipt: SourceStatementReceipt) => receipt.messages.reduce((sum, result) =>
    sum + result.rejections.filter(rejection => rejection.statement_index !== null).length, 0);
  const admittedTotal = compiled.receipt.messages.reduce((sum, result) => sum + result.statements.length, 0);
  const unassigned = Math.max(0, compiled.rawCount - admittedTotal - statementRejections(compiled.receipt));
  const selectedReceipt = { ...compiled.receipt, messages };
  stats.lastExtractionSource = compiled.source;
  stats.lastExtractionShards = [...compiled.shards];
  stats.lastCacheKey = compiled.singleRequestCacheKey;
  stats.lastRawJsonSha256 = compiled.singleRequestCacheKey !== null && compiled.shards.length === 1
    ? compiled.shards[0]!.rawJsonSha256 : null;
  stats.lastTurnDraftCount = accepted;
  stats.lastTurnRawSignalCount = accepted + statementRejections(selectedReceipt) + (firstUse ? unassigned : 0);
  stats.lastStatementSession = { receipt: compiled.receipt, firstUse, unassignedRawStatements: unassigned,
    ...(firstUse ? { responses: compiled.responses } : {}) };
  const signals = emitSourceStatementSignals({ receipt: selectedReceipt, messages: context.turn_messages,
    artifactKey: context.artifact_key, sourceRootId: context.source_root_id, workspaceId: context.workspace_id,
    runId: context.run_id, surfaceId: context.surface_id, createdAt: new Date().toISOString(),
    sourceObservation: context.source_observation ?? null, generateSignalId: randomUUID, sourceContexts: input.sourceContexts });
  // Failure accounting and redacted diagnostics belong to the first session use,
  // while each raw round still receives its independently admitted siblings.
  if (firstUse && compiled.failure !== undefined) {
    throw new OfficialApiGardenCompileIncompleteError(compiled.receipt, { cause: compiled.failure.cause, signals });
  }
  return signals;
}

async function extractSession(input: Parameters<typeof compileSessionSeedSignals>[0], sessionId: string): Promise<CompiledStatementSession> {
  let receipt: SourceStatementReceipt;
  let failure: OfficialApiGardenCompileIncompleteError | undefined;
  try {
    receipt = await input.provider.extractSourceStatements("", { ...input.context,
      run_id: sessionId, turn_messages: input.sourceSession });
  } catch (error) {
    if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error;
    // Isolation/identity failures must stop the caller, not become successful raw absence.
    if (error.cause instanceof ExtractionCacheInvariantError) throw error.cause;
    receipt = error.receipt;
    failure = error;
  }
  return { receipt, ...(failure === undefined ? {} : { failure }), source: input.stats.lastExtractionSource, shards: [...(input.stats.lastExtractionShards ?? [])],
    singleRequestCacheKey: receipt.chunks.length === 1 ? input.stats.lastCacheKey ?? null : null,
    rawCount: input.stats.lastTurnRawSignalCount, responses: [...(input.stats.lastStatementResponses ?? [])] };
}
