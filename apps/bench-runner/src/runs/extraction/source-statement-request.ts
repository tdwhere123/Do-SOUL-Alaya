import { createHash } from "node:crypto";
import {
  SourceStatementRequestSchema, type ConversationMessage, type SourceStatementRequest
} from "@do-soul/alaya-protocol";
import { planSourceStatementSession, receiveSourceStatements, sourceStatementSessionInput,
  SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";

/** Host-only session identity: no question, answer, label, workspace or extraction run. */
export function sourceStatementSession(messages: readonly ConversationMessage[]) {
  const source = sourceStatementSessionInput(messages);
  const sessionId = createHash("sha256").update(JSON.stringify(source.messages)).digest("hex");
  return { sessionId, ...source };
}

export function sourceStatementRequests(messages: readonly ConversationMessage[]) {
  const session = sourceStatementSession(messages);
  return planSourceStatementSession(session.sessionId, session.messages).flatMap(chunk =>
    "request" in chunk ? [{ source: chunk.request, userPrompt: JSON.stringify(chunk.request) }] : []);
}

export function statementSourceUnits(request: SourceStatementRequest, datasetRevision: string) {
  return request.messages.map(message => ({ contract: request.contract, message,
    binding: { occurrenceIdentity: createHash("sha256").update(JSON.stringify({ contract: request.contract,
      session_id: request.session_id, message, datasetRevision })).digest("hex") }
  }));
}

export function parseStatementRequest(userPrompt: string): SourceStatementRequest {
  return SourceStatementRequestSchema.parse(JSON.parse(userPrompt));
}

/** Request completion accounts for the response, not semantic exhaustion of a session.
 * The receiver's per-message partial/failed states remain present in the cached receipt.
 */
export function inspectStatementResponse(request: SourceStatementRequest, rawJson: string) {
  const receipt = receiveSourceStatements(request, rawJson);
  const admitted = receipt.messages.reduce((sum, message) => sum + message.statements.length, 0);
  const complete = receipt.rejections.length === 0 && receipt.messages.every(message => message.status === "complete");
  return { receipt, admitted, complete,
    status: admitted > 0 ? "completed_signals" as const : complete ? "completed_empty" as const : "unclassified_empty" as const };
}

export function assertStatementRequestPrompt(systemPrompt: string): void {
  if (systemPrompt !== SOURCE_STATEMENTS_PROMPT) throw new TypeError("statement request prompt identity mismatch");
}
