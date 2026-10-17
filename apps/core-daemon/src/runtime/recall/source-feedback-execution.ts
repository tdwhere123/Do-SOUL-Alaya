import { canonicalJson, SourceSemanticWorkerWorkSchema } from "@do-soul/alaya-protocol";
import { CoreError, createSourceFeedbackSession, captureSourceFeedbackTerminalCause, type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import { SourceSemanticsPublicPayloadSchema, type SourceSemanticsPublicPayload } from "../recall-read-worker/operation-schemas.js";
import type { SourceSemanticsExecutionPort } from "./recall-read-worker-client.js";

/** Trusted Node wiring only. No MCP delivery, joined qualification, frozen continuation or write capability. */
export async function executeSourceFeedback(input: Readonly<{
  session: SourceFeedbackSessionInput;
  context: Omit<SourceSemanticsPublicPayload, "request">;
  port: SourceSemanticsExecutionPort;
  signal?: AbortSignal;
  timeoutMs: number;
}>) {
  // Capture before any await; scope admission/principal/clock cannot drift between fresh actions.
  const context = SourceSemanticsPublicPayloadSchema.parse({ ...structuredClone(input.context), request: input.session.seed });
  const sessionInput = structuredClone(input.session);
  if (context.workspace_id !== sessionInput.workspace_id || context.as_of !== sessionInput.as_of
    || sessionInput.scope_identity !== canonicalJson([context.principal ?? null, context.authorized_scopes])) {
    throw new CoreError("VALIDATION", "feedback root context differs from native execution context");
  }
  const session = createSourceFeedbackSession(sessionInput);
  let active: string | undefined, closed = false;
  let phase: () => "waiting" | "preparing" | "dispatched" | "unknown" = () => "unknown";
  try {
    await input.port.withExecutionScope({ ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: input.timeoutMs }, async readPhase => {
      phase = readPhase;
      while (!closed) {
        input.signal?.throwIfAborted();
        const next = session.next();
        if (next.status !== "action") break;
        active = next.action.action_id;
        const result = await input.port.execute({ ...context, request: next.action.request });
        input.signal?.throwIfAborted();
        if (closed) return; // A scope timeout may have already settled the reserved action as unknown.
        session.accept(active, { status: "observed", result });
        active = undefined;
      }
    });
  } catch (error) {
    closed = true;
    const terminal_cause = captureSourceFeedbackTerminalCause(input.signal?.aborted ? input.signal.reason : error,
      input.signal?.aborted ? "caller_abort" : "execution_error");
    if (active !== undefined) {
      const work = error instanceof CoreError ? SourceSemanticWorkerWorkSchema.safeParse(error.details?.work) : undefined;
      session.accept(active, work?.success === true ? { status: "failed", work: work.data, terminal_cause }
        : { status: "unknown", phase: phase(), terminal_cause });
    } else session.stop(input.signal?.aborted ? "cancelled" : "unknown", terminal_cause);
  } finally { closed = true; }
  return session.finish();
}
