import { createHash } from "node:crypto";
import { canonicalJson, SourceStatementRequestSchema, type GardenCompleteTaskRequest, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { OfficialApiGardenProvider, OfficialApiGardenCompileIncompleteError,
  SOURCE_STATEMENTS_PROMPT, planSourceStatementSession, sourceStatementSessionInput } from "@do-soul/alaya-soul";
import { buildGardenTaskSignalId } from "../support/task-signal-id.js";
import { buildPostTurnContent, buildPostTurnConversationMessages, type PostTurnExtractTaskPayload } from "./task-payload.js";

type Responses = NonNullable<NonNullable<GardenCompleteTaskRequest["result_envelope"]>["source_statement_responses"]>;

/** The same planner exposes bounded requests to a host worker; the worker does not invent host bindings. */
export function sourceStatementTaskRequests(payload: PostTurnExtractTaskPayload, taskId: string) {
  const source = sourceStatementSessionInput(buildPostTurnConversationMessages(payload, taskId));
  const plan = planSourceStatementSession(payload.run_id, source.messages);
  return { system_prompt: SOURCE_STATEMENTS_PROMPT,
    requests: plan.flatMap(chunk => "request" in chunk ? [chunk.request] : []),
    raw_fallback_message_ids: plan.flatMap(chunk => "message" in chunk ? [chunk.message.message_id] : []) };
}

export function sourceStatementTaskCompletionEnvelope(taskId: string, responses: Responses): string {
  return canonicalJson({ contract: "source-statements-v1", task_id: taskId,
    fingerprint: createHash("sha256").update(canonicalJson(responses)).digest("hex") });
}

/** The claimant supplies transport bytes only. Publication still goes through the ordinary signal owner. */
export async function receiveSourceStatementTask(input: Readonly<{
  taskId: string; payload: PostTurnExtractTaskPayload; responses: Responses; now: () => string;
}>): Promise<Readonly<{ signals: readonly CandidateMemorySignal[]; incomplete: boolean }>> {
  const requests = sourceStatementTaskRequests(input.payload, input.taskId).requests;
  const allowed = new Set(requests.map(request => request.chunk_index));
  const responses = new Map<number, string>();
  for (const response of input.responses) {
    if (!allowed.has(response.chunk_index) || responses.has(response.chunk_index)) {
      throw new TypeError("host-worker statement response has a duplicate or unknown chunk");
    }
    responses.set(response.chunk_index, response.raw_json);
  }
  let signalIndex = 0;
  const provider = new OfficialApiGardenProvider({ injectedExtractorCapability: "cache_only", now: input.now,
    generateSignalId: () => buildGardenTaskSignalId(input.taskId, signalIndex++), extractor: {
      extract: async request => {
        const chunk = SourceStatementRequestSchema.parse(JSON.parse(request.userPrompt));
        const planned = requests.find(value => value.chunk_index === chunk.chunk_index);
        if (planned === undefined || canonicalJson(planned) !== canonicalJson(chunk)) throw new TypeError("host-worker request binding changed");
        const rawJson = responses.get(chunk.chunk_index);
        if (rawJson === undefined) throw new TypeError("host-worker statement response is missing");
        return { rawJson };
      }
    } });
  try {
    const signals = await provider.compile(buildPostTurnContent(input.payload), {
      workspace_id: input.payload.workspace_id, run_id: input.payload.run_id, surface_id: null,
      turn_messages: buildPostTurnConversationMessages(input.payload, input.taskId), artifact_key: `post-turn:${input.taskId}`,
      source_root_id: input.payload.admitted_source_root_id,
      // A completion time is not a message occurrence time or a source-observation receipt.
      source_observation: null
    });
    return { signals, incomplete: false };
  } catch (error) {
    if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error;
    return { signals: error.signals, incomplete: true };
  }
}
