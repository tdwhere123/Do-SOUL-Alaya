import { canonicalJson, SourceSemanticWorkerWorkSchema } from "@do-soul/alaya-protocol";
import { CoreError, createSourceFeedbackSession, captureSourceFeedbackTerminalCause,
  type SourceFeedbackSessionInput, type SourceFeedbackCorrespondenceAction,
  type SourceFeedbackCorrespondenceHost } from "@do-soul/alaya-core";
import { SourceSemanticsPublicPayloadSchema, type SourceSemanticsPublicPayload } from "../recall-read-worker/operation-schemas.js";
import type { SourceSemanticsExecutionPort } from "./recall-read-worker-client.js";
import type { AlayaDaemonRuntime } from "../daemon/lifecycle/daemon-runtime-types.js";

const runtimePorts = new WeakMap<object, SourceSemanticsExecutionPort>();

/** Named consumer: createAlayaDaemonRuntime. The existing client retains lifetime/close ownership. */
export function bindSourceFeedbackExecutionPort(runtime: AlayaDaemonRuntime, port: SourceSemanticsExecutionPort): void {
  if (runtimePorts.has(runtime)) throw new CoreError("CONFLICT", "source feedback execution port already bound");
  runtimePorts.set(runtime, port);
}

export type SourceFeedbackRuntimeInput = Omit<Parameters<typeof executeSourceFeedback>[0], "port">;

/** Private daemon/bench Node friend entry. Import from the same dist owner as the runtime constructor.
 * No raw client/port escape, public runtime property, worker operation or seed construction.
 * Object identity and registry membership own admission across source/dist type declarations. */
export async function executeSourceFeedbackForRuntime(runtime: object, input: SourceFeedbackRuntimeInput) {
  const port = runtimePorts.get(runtime);
  if (port === undefined) throw new CoreError("CONFLICT", "source feedback execution port is not bound");
  return await executeSourceFeedback({ ...input, port });
}

/** Trusted Node wiring only. No MCP delivery, joined qualification, frozen continuation or write capability. */
export async function executeSourceFeedback(input: Readonly<{
  session: SourceFeedbackSessionInput;
  context: Omit<SourceSemanticsPublicPayload, "request">;
  port: SourceSemanticsExecutionPort;
  correspondence?: SourceFeedbackCorrespondenceHost;
  signal?: AbortSignal;
  timeoutMs: number;
}>) {
  // Capture before any await; scope admission/principal/clock cannot drift between fresh actions.
  const context = SourceSemanticsPublicPayloadSchema.parse({ ...structuredClone(input.context), request: input.session.seed });
  const captured = structuredClone(input.session);
  const correspondence = input.correspondence;
  const prepareCorrespondence = correspondence?.prepare.bind(correspondence);
  if (captured.correspondence_policy_id !== undefined && captured.correspondence_policy_id !== correspondence?.policy_id) {
    throw new CoreError("VALIDATION", "feedback correspondence host is missing or its policy changed");
  }
  const sessionInput = { ...captured, ...(correspondence === undefined ? {} : {
    correspondence_policy_id: correspondence.policy_id }) };
  if (context.workspace_id !== sessionInput.workspace_id || context.as_of !== sessionInput.as_of
    || sessionInput.scope_identity !== canonicalJson([context.principal ?? null, context.authorized_scopes])) {
    throw new CoreError("VALIDATION", "feedback root context differs from native execution context");
  }
  const session = createSourceFeedbackSession(sessionInput);
  let active: string | undefined, closed = false, preparingCorrespondence = false;
  let phase: () => "waiting" | "preparing" | "dispatched" | "unknown" = () => "unknown";
  try {
    await input.port.withExecutionScope({ ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: input.timeoutMs }, async readPhase => {
      phase = readPhase;
      while (!closed) {
        input.signal?.throwIfAborted();
        const next = session.next();
        if (next.status !== "action") break;
        active = next.action.action_id;
        preparingCorrespondence = next.action.request.kind === "prepare_correspondence";
        const settlement = next.action.request.kind === "prepare_correspondence"
          ? { status: "prepared" as const, result: await prepareCorrespondence!(next.action as SourceFeedbackCorrespondenceAction) }
          : { status: "observed" as const, result: await input.port.execute({ ...context, request: next.action.request }) };
        input.signal?.throwIfAborted();
        if (closed) return; // A scope timeout may have already settled the reserved action as unknown.
        session.accept(active, settlement);
        active = undefined; preparingCorrespondence = false;
      }
    });
  } catch (error) {
    closed = true;
    const terminal_cause = captureSourceFeedbackTerminalCause(input.signal?.aborted ? input.signal.reason : error,
      input.signal?.aborted ? "caller_abort" : "execution_error");
    if (active !== undefined) {
      const work = error instanceof CoreError ? SourceSemanticWorkerWorkSchema.safeParse(error.details?.work) : undefined;
      session.accept(active, work?.success === true ? { status: "failed", work: work.data, terminal_cause }
        : { status: "unknown", phase: preparingCorrespondence ? "preparing" : phase(), terminal_cause });
    } else session.stop(input.signal?.aborted ? "cancelled" : "unknown", terminal_cause);
  } finally { closed = true; }
  return session.finish();
}
