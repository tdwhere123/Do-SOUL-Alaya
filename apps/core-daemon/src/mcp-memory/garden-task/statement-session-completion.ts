import type { GardenCompleteTaskRequest } from "@do-soul/alaya-protocol";
import type { GardenTaskRow } from "@do-soul/alaya-storage";
import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import { createSignalOutcomeCounter } from "../../garden/post-turn-extract/signal-receiver.js";
import type { StatementSessionExtraction } from "../../garden/statement-session/statement-session-extraction-receipts.js";
import {
  StatementSessionSourceUnavailableError, parseStatementSessionTaskPayload, receiveStatementSessionResponses
} from "../../garden/statement-session/statement-session-task.js";
import { emitTaskCandidateSignals } from "../garden-task-completion/candidate-signal-emission.js";
import { GardenTaskUnavailableError, GardenTaskValidationError } from "./garden-task-handler-support.js";
import type { GardenTaskHandlerDependencies, GardenTaskToolCallContext } from "./garden-task-handlers.js";

export function requireStatementSessionCompletion(deps: GardenTaskHandlerDependencies) {
  if (deps.statementSessionCompletion === undefined) {
    throw new GardenTaskUnavailableError("Statement session completion is not available.");
  }
  return deps.statementSessionCompletion;
}

export async function admitClaimedStatementSession(
  deps: GardenTaskHandlerDependencies,
  repo: NonNullable<GardenTaskHandlerDependencies["gardenTaskRepo"]>,
  row: GardenTaskRow,
  request: GardenCompleteTaskRequest,
  context: GardenTaskToolCallContext,
  resolvedRunId: string | null,
  claimToken: string,
  now: () => string
): Promise<StatementSessionExtraction | null> {
  const completion = requireStatementSessionCompletion(deps);
  const payload = parseStatementSessionTaskPayload(row.payload);
  if (payload.workspace_id !== context.workspaceId || payload.run_id !== resolvedRunId) {
    throw new GardenTaskValidationError(`Garden task statement session payload escaped the claimed workspace or run: ${row.id}`);
  }
  const assertClaim = () => {
    throwIfAborted(context.abortSignal);
    if (!repo.refreshClaim(row.id, claimToken, now())) {
      throw new GardenTaskValidationError(`Garden task claim changed during statement session completion: ${row.id}`);
    }
  };
  let extraction = completion.receipts.read(row, payload.run_id);
  if (extraction === null && request.status === "completed") {
    const responses = request.result_envelope?.source_statement_responses;
    if (responses === undefined) throw new GardenTaskValidationError("SOURCE_STATEMENT_SESSION requires source_statement_responses.");
    const statements = await receiveStatementSessionResponses({ taskId: row.id, payload,
      sources: repo.statementSessions, responses, now }).catch(error => {
      if (!(error instanceof StatementSessionSourceUnavailableError)) throw error;
      throw new GardenTaskValidationError(`Garden task statement session source is unavailable: ${row.id}`);
    });
    const counts = createSignalOutcomeCounter();
    const emitted = await emitTaskCandidateSignals({ deps, now }, row, statements.signals, claimToken, counts, true);
    extraction = { status: statements.status, emitted_signal_ids: emitted, ...counts.snapshot() };
    await completion.receipts.record(row, payload.run_id, extraction, assertClaim);
  }
  if (extraction !== null && extraction.emitted_signal_ids.length > 0) {
    assertClaim();
    await completion.admitRelations({ workspaceId: context.workspaceId, runId: payload.run_id });
  }
  return extraction;
}
