import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import type { SourceSemanticsExecutionPort } from "../../../runtime/recall/recall-read-worker-client.js";
import type { SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CHILD, CONTEXT, withFeedbackSource } from "./source-feedback.test-support.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

it("does not accept a late genuine native binding or dispatch fresh discovery after caller abort", async () => {
  await withFeedbackSource("AP-42", async ({ client, session }) => {
    const nativePort = client.sourceSemanticsPort!, controller = new AbortController();
    const bindingReady = deferred<SourceSemanticWorkerResult>(), deliver = deferred(), completed = deferred();
    const reason = new Error("caller no longer authorizes feedback");
    const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async input => {
      const result = await nativePort.execute(input);
      if (input.request.kind === "reason") {
        bindingReady.resolve(result);
        // Controlled transport delay deliberately ignores cancellation. Native work
        // already completed; this is a late-acceptance test, NOT physical-exit proof.
        await deliver.promise;
        completed.resolve();
      }
      return result;
    });
    const port: SourceSemanticsExecutionPort = { ...nativePort, execute };
    try {
      const running = executeSourceFeedback({ session, context: CONTEXT, port, signal: controller.signal, timeoutMs: 20_000 });
      const actual = await bindingReady.promise;
      if (actual.kind !== "reason") throw new Error("native accepting result required");
      expect(actual.result?.outcome.status).toBe("interpreted");
      expect(actual.result?.binding_results?.[0]?.returned.ticket).toMatchObject({ node_id: "rTicket" });
      expect(actual.interpretation?.mentions.find(row => row.id === "mTicket")).toMatchObject({ text: "AP-42", utf8_span: [8, 13] });
      controller.abort(reason);
      const trace = await running;
      expect(trace.status).toBe("unknown");
      expect(trace.terminal_cause).toMatchObject({ kind: "caller_abort", message: reason.message });
      expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source"]);
      expect(trace.accounting.reserved_work).toBe(CHILD.work_units);
      expect(trace.accounting.reserved_memory_bytes).toBe(CHILD.memory_bytes);
      deliver.resolve(); await completed.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(execute.mock.calls.map(([input]) => input.request.kind)).toEqual(["prepare_source", "validate_source", "reason"]);
      expect(trace.exposures.some(row => row.result.kind === "reason" || row.result.kind === "prepare_query")).toBe(false);
      expect(trace.joint_assessment.status).toBe("not_lowered");
    } finally { deliver.resolve(); }
  });
}, 60_000);
