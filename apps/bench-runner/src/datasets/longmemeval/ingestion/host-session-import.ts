import {
  AlayaError, HOST_SESSION_LIMITS, HostSessionCaptureRequestSchema, type HostScopedReference, type HostSessionCaptureRequest,
  type HostSessionCaptureResponse
} from "@do-soul/alaya-protocol";
import type { HostSessionIssuer } from "../../../../../core-daemon/src/garden/host-session/host-session-capture.js";
import { assertVerifiedLongMemEvalDatasetMembership, type LoadedLongMemEvalDataset } from "./fetch.js";
import { conversationRole, type LongMemEvalQuestion } from "./dataset.js";
import { requireLongMemEvalTimestamp } from "./source-time.js";

export const LONGMEMEVAL_HOST_SESSION_PRODUCER = "longmemeval-structured-source";
const UNVERIFIED_LONGMEMEVAL_HOST_SESSION_PRODUCER = "longmemeval-unverified-source";

/** A LongMemEval haystack session is one host container; scope and id together identify it. */
export function longMemEvalSessionContainer(questionId: string, sessionIndex: number): HostScopedReference {
  return { scope: "longmemeval_s", id: `${questionId}:s${sessionIndex}` };
}

/** Only a verified dataset pin may assert LongMemEval host facts. */
export function createLongMemEvalHostSessionIssuer(dataset: LoadedLongMemEvalDataset): HostSessionIssuer {
  const authority = dataset.promotionAuthority;
  assertVerifiedLongMemEvalDatasetMembership(authority,
    { variant: "longmemeval_s", sha256: dataset.sha256, questions: structuredClone(dataset.questions) });
  const namespace = `longmemeval:${dataset.sha256}`;
  return Object.freeze({ producer: LONGMEMEVAL_HOST_SESSION_PRODUCER, binding: request => ({ namespace,
    workspace_id: request.workspace_id, producer: LONGMEMEVAL_HOST_SESSION_PRODUCER, basis: "pinned_dataset" as const }) });
}

/** A copy without the verified pin is captured like any host's conversation: its own structure, never dataset authority. */
export function createUnverifiedLongMemEvalHostSessionIssuer(datasetSha256: string): HostSessionIssuer {
  const namespace = `longmemeval-unverified:${datasetSha256}`;
  return Object.freeze({ producer: UNVERIFIED_LONGMEMEVAL_HOST_SESSION_PRODUCER, binding: request => ({ namespace,
    workspace_id: request.workspace_id, producer: UNVERIFIED_LONGMEMEVAL_HOST_SESSION_PRODUCER, basis: "host_session" as const }) });
}

/** Each session's complete messages in request-sized windows; the last window closes the session. */
export function longMemEvalHostSessionRequests(question: LongMemEvalQuestion):
  readonly Readonly<{ sessionIndex: number; requests: readonly HostSessionCaptureRequest[] }>[] {
  return question.haystack_sessions.map((session, sessionIndex) => {
    const hostReportedAt = requireLongMemEvalTimestamp(question.haystack_dates[sessionIndex]);
    const container = longMemEvalSessionContainer(question.question_id, sessionIndex);
    const messages = session.map((message, position) => {
      const content = boundedContent(message.content);
      return { message_id: `${question.question_id}:s${sessionIndex}:m${position}`, position, role: conversationRole(message.role),
        content, completeness: content === message.content ? "complete" as const : "excerpt" as const,
        fidelity: "original_bytes" as const, host_reported_at: hostReportedAt };
    });
    const requests: HostSessionCaptureRequest[] = [];
    for (let start = 0; start < messages.length; start += HOST_SESSION_LIMITS.messagesPerRequest) {
      const window = messages.slice(start, start + HOST_SESSION_LIMITS.messagesPerRequest);
      requests.push(HostSessionCaptureRequestSchema.parse({ container, messages: window,
        ...(start + window.length === messages.length ? { closes_tail: true } : {}) }));
    }
    return { sessionIndex, requests };
  });
}

/** Imports one question's haystack through the daemon's host-session capture owner. */
export async function importLongMemEvalQuestion(
  capture: (request: HostSessionCaptureRequest, issuer: HostSessionIssuer) => Promise<HostSessionCaptureResponse>,
  question: LongMemEvalQuestion, issuer: HostSessionIssuer
): Promise<readonly HostSessionCaptureResponse[]> {
  const responses: HostSessionCaptureResponse[] = [];
  for (const session of longMemEvalHostSessionRequests(question)) {
    for (const request of session.requests) responses.push(await captureLongMemEvalWindow(() => capture(request, issuer)));
  }
  return responses;
}

/** Publication consumers finish each accepted window before checkpointing its sources. */
export async function captureLongMemEvalWindow(capture: () => Promise<HostSessionCaptureResponse>,
  checkCancellation: () => void = () => undefined): Promise<HostSessionCaptureResponse> {
  checkCancellation();
  const first = await capture();
  let result = first, admitted = first.admitted_round_count;
  while ((result.pending_round_count ?? 0) > 0) {
    checkCancellation();
    const previous = result.pending_round_count!;
    result = await capture();
    if ((result.pending_round_count ?? 0) >= previous) {
      throw new AlayaError("UNAVAILABLE", "host session publication made no recovery progress");
    }
    admitted += result.admitted_round_count;
  }
  return { ...first, admitted_round_count: admitted, pending_round_count: result.pending_round_count };
}

/** A message over the capture limit is retained as an honest leading excerpt, never silently dropped. */
function boundedContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= HOST_SESSION_LIMITS.contentBytes) return content;
  let end = 0, used = 0;
  for (const scalar of content) {
    used += Buffer.byteLength(scalar, "utf8");
    if (used > HOST_SESSION_LIMITS.contentBytes) break;
    end += scalar.length;
  }
  return content.slice(0, end);
}
