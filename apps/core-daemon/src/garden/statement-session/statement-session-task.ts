import { createHash } from "node:crypto";
import {
  AlayaError, GardenTaskKind, SOURCE_STATEMENTS_CONTRACT, SourceStatementRequestSchema, canonicalJson,
  type CandidateMemorySignal, type GardenCompleteTaskRequest, type SourceStatementMessage, type SourceStatementReceipt,
  type SourceStatementRequest
} from "@do-soul/alaya-protocol";
import { SOURCE_STATEMENTS_PROMPT, emitSourceStatementSessionSignals, extractSourceStatementRequest,
  type LocatedSourceStatementMessage } from "@do-soul/alaya-soul";
import type { GardenStatementSessionSources, StatementSessionRoot } from "@do-soul/alaya-storage";
import { buildGardenTaskSignalId } from "../support/task-signal-id.js";

export type StatementSessionSourcesPort = Pick<GardenStatementSessionSources, "roundPage" | "roundForRoot" | "roundAt" |
  "contextPage" | "planningState" | "savePlanningState" | "transaction" | "lastChunkPayload" | "root" |
  "reserveTailBoundary" | "nextTailBoundary" | "tailBoundaryReady" | "completeTailBoundary">;
/** Consecutive host occurrences [from, to) of one admitted root. */
export type StatementSessionMember = Readonly<{ root_id: string; source_id: string; from: number; to: number }>;
/** Root ids and occurrence ranges only: messages are always re-read from their admitted roots.
 * `container_key` is absent only on chunks queued before sessions were keyed by container; they still
 * execute but no plan resumes after them. `run_id` is signal attribution, not the session key.
 */
export type StatementSessionTaskPayload = Readonly<{
  task_kind: typeof GardenTaskKind.SOURCE_STATEMENT_SESSION; workspace_id: string; container_key?: string;
  run_id: string; session_id: string; chunk_index: number;
  context: readonly StatementSessionMember[]; targets: readonly StatementSessionMember[]; closes_tail: boolean;
}>;
type Responses = NonNullable<NonNullable<GardenCompleteTaskRequest["result_envelope"]>["source_statement_responses"]>;

export class StatementSessionSourceUnavailableError extends AlayaError {
  public constructor(reason: string) {
    super("VALIDATION", `Statement session source is unavailable: ${reason}`);
    this.name = "StatementSessionSourceUnavailableError";
  }
}

export function statementSessionTaskId(payload: StatementSessionTaskPayload): string {
  const digest = createHash("sha256").update(canonicalJson([payload.workspace_id, payload.container_key ?? null,
    payload.chunk_index, payload.targets])).digest("hex").slice(0, 32);
  return `source_statement_session_${digest}`;
}

export function parseStatementSessionTaskPayload(value: unknown): StatementSessionTaskPayload {
  const row = record(value);
  const members = (field: unknown, allowEmpty: boolean) => {
    if (!Array.isArray(field) || (!allowEmpty && field.length === 0)) invalid();
    return field.map((entry): StatementSessionMember => {
      const member = record(entry);
      const from = member?.from, to = member?.to;
      if (!nonEmpty(member?.root_id) || !nonEmpty(member?.source_id) || !isIndex(from) || !isIndex(to) || from >= to) invalid();
      return { root_id: member!.root_id as string, source_id: member!.source_id as string, from: from as number, to: to as number };
    });
  };
  if (row?.task_kind !== GardenTaskKind.SOURCE_STATEMENT_SESSION || !nonEmpty(row.workspace_id) || !nonEmpty(row.run_id) ||
      !nonEmpty(row.session_id) || !isIndex(row.chunk_index) || typeof row.closes_tail !== "boolean" ||
      (row.container_key !== undefined && !nonEmpty(row.container_key))) invalid();
  return { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, workspace_id: row!.workspace_id as string,
    ...(row!.container_key === undefined ? {} : { container_key: row!.container_key as string }),
    run_id: row!.run_id as string, session_id: row!.session_id as string, chunk_index: row!.chunk_index as number,
    context: members(row!.context, true), targets: members(row!.targets, false), closes_tail: row!.closes_tail as boolean };
}

/** Occurrence-level messages of one admitted root; a message must name its host role. Its recorded time is
 * the host-reported time the issuer asserted, never Alaya's receipt. */
export function rootStatementMessages(root: StatementSessionRoot): readonly LocatedSourceStatementMessage[] {
  const bytes = Buffer.from(root.content, "utf8");
  const binding = { root_id: root.root_id, source_id: root.source_id, source_version: root.source_version,
    content_digest: root.content_digest };
  return root.occurrences.map((occurrence): LocatedSourceStatementMessage => {
    if (occurrence.role === null) throw new StatementSessionSourceUnavailableError("host message role unknown");
    const message: SourceStatementMessage = { message_id: occurrence.occurrence_id, role: occurrence.role,
      recorded_at: occurrence.host_reported_at ?? null, text: bytes.subarray(...occurrence.utf8_span).toString("utf8") };
    return { message, root: binding, utf8_span: occurrence.utf8_span };
  });
}

/** Rebuilds the planned request from current roots; any unavailable member fails the whole request. */
export function readStatementSessionRequest(sources: Pick<StatementSessionSourcesPort, "root">,
  payload: StatementSessionTaskPayload): Readonly<{ request: SourceStatementRequest; located: readonly LocatedSourceStatementMessage[] }> {
  const roots = new Map<string, readonly LocatedSourceStatementMessage[]>();
  const select = (members: readonly StatementSessionMember[]) => members.flatMap(member => {
    let messages = roots.get(member.root_id);
    if (messages === undefined) {
      const read = sources.root(payload.workspace_id, member.root_id);
      if (read.status === "unavailable") throw new StatementSessionSourceUnavailableError(read.reason);
      if (read.root.source_id !== member.source_id) throw new StatementSessionSourceUnavailableError("source binding changed");
      messages = rootStatementMessages(read.root);
      roots.set(member.root_id, messages);
    }
    if (member.to > messages.length) throw new StatementSessionSourceUnavailableError("host message range changed");
    return messages.slice(member.from, member.to);
  });
  const context = select(payload.context), targets = select(payload.targets);
  const request = SourceStatementRequestSchema.parse({ contract: SOURCE_STATEMENTS_CONTRACT, session_id: payload.session_id,
    chunk_index: payload.chunk_index, context: context.map(row => row.message), messages: targets.map(row => row.message) });
  return { request, located: [...context, ...targets] };
}

export function statementSessionHostWorkerPayload(sources: Pick<StatementSessionSourcesPort, "root">,
  payload: StatementSessionTaskPayload) {
  return { run_id: payload.run_id, workspace_id: payload.workspace_id, chunk_index: payload.chunk_index,
    source_statements: { system_prompt: SOURCE_STATEMENTS_PROMPT, requests: [readStatementSessionRequest(sources, payload).request] } };
}

/** Per-root statement signals of one settled request; ids are stable per task for replay. */
export function emitStatementSessionTaskSignals(input: Readonly<{
  taskId: string; payload: StatementSessionTaskPayload; request: SourceStatementRequest;
  located: readonly LocatedSourceStatementMessage[]; receipt: SourceStatementReceipt; createdAt: string;
  /** Each statement keeps its own turn's receipt observation; a chunk spans several turns. */
  sourceObservation: (rootId: string) => CandidateMemorySignal["source_observation"];
}>): readonly CandidateMemorySignal[] {
  let signalIndex = 0;
  return emitSourceStatementSessionSignals({ receipt: input.receipt, requests: [input.request], located: input.located,
    workspaceId: input.payload.workspace_id, runId: input.payload.run_id, surfaceId: null, createdAt: input.createdAt,
    sourceObservation: null, generateSignalId: () => buildGardenTaskSignalId(input.taskId, signalIndex++) })
    .map(signal => ({ ...signal, source_observation: input.sourceObservation(signal.raw_payload.source_statement.source_root_id) }));
}

export function statementSessionCompletionEnvelope(taskId: string, responses: Responses): string {
  return canonicalJson({ contract: SOURCE_STATEMENTS_CONTRACT, task_id: taskId,
    fingerprint: createHash("sha256").update(canonicalJson(responses)).digest("hex") });
}

/** The claimant supplies transport bytes only; binding and publication stay with the daemon. */
export async function receiveStatementSessionResponses(input: Readonly<{
  taskId: string; payload: StatementSessionTaskPayload; sources: Pick<StatementSessionSourcesPort, "root">;
  responses: Responses; now: () => string;
}>): Promise<Readonly<{ signals: readonly CandidateMemorySignal[]; incomplete: boolean }>> {
  const { request, located } = readStatementSessionRequest(input.sources, input.payload);
  if (input.responses.some(response => response.chunk_index !== request.chunk_index) || input.responses.length > 1) {
    throw new TypeError("host-worker statement response has a duplicate or unknown chunk");
  }
  const rawJson = input.responses[0]?.raw_json;
  const { receipt } = await extractSourceStatementRequest({ request, transport: async () => {
    if (rawJson === undefined) throw new TypeError("host-worker statement response is missing");
    return { rawJson };
  } });
  return { signals: emitStatementSessionTaskSignals({ taskId: input.taskId, payload: input.payload, request, located,
    // A completion time is not a message occurrence time or a source-observation receipt.
    receipt, createdAt: input.now(), sourceObservation: () => null }), incomplete: receipt.status !== "complete" };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function invalid(): never {
  throw new TypeError("Invalid statement session task payload.");
}
