import { describe, expect, it } from "vitest";

type ParseableSchema = {
  readonly parse: (value: unknown) => unknown;
  readonly options?: readonly string[];
};

describe("Phase A1 event registry", () => {
  it("exports the frozen wire events and parses the published A1 payloads", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const EventTypeSchema = protocol.EventTypeSchema as ParseableSchema;
    const ToolWorkerEventType = protocol.ToolWorkerEventType as Record<string, string>;
    const ToolWorkerEventTypeSchema = protocol.ToolWorkerEventTypeSchema as ParseableSchema;
    const ToolWorkerEventUnionSchema = protocol.ToolWorkerEventUnionSchema as ParseableSchema;
    const parseToolWorkerEventPayload = protocol.parseToolWorkerEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;
    const ToolCallStartedPayloadSchema = protocol.ToolCallStartedPayloadSchema as ParseableSchema;
    const WorkerStateChangedPayloadSchema = protocol.WorkerStateChangedPayloadSchema as ParseableSchema;
    const canonicalGovernanceSubject = protocol.canonicalGovernanceSubject as (
      domain: string,
      qualifiers?: Record<string, string>
    ) => {
      readonly subject_domain: string;
      readonly subject_qualifiers: Readonly<Record<string, string>>;
      readonly canonical_key: string;
    };

    const expectedEventTypes = [
      "tool.intent.created",
      "tool.intent.approved",
      "tool.intent.denied",
      "tool_call.started",
      "tool_call.completed",
      "worker.state_changed",
      "governance_spam_fault"
    ] as const;

    expect(Object.values(ToolWorkerEventType)).toEqual(expectedEventTypes);
    expect(ToolWorkerEventTypeSchema.options).toEqual(expectedEventTypes);

    const governanceSubject = canonicalGovernanceSubject("runtime_governance", { scope: "workspace" });
    const toolIntentCreatedPayload = {
      executionId: "exec-1",
      toolId: "tool.read_workspace",
      requestedBy: "principal",
      requestingRunId: "run-1",
      nodeId: "node-1",
      governanceSubject
    } as const;
    const toolIntentApprovedPayload = {
      executionId: "exec-1",
      governanceDecisionRef: "decision-1",
      matchedClaimRefs: ["claim-1"],
      matchedSlotRefs: ["slot-1"],
      requiresRedCard: false
    } as const;
    const toolIntentDeniedPayload = {
      executionId: "exec-2",
      governanceDecisionRef: "decision-2",
      explanationSummary: "Blocked by governance policy.",
      hardConstraintsPresent: true
    } as const;
    const toolCallStartedPayload = {
      toolCallId: "tool-call-1",
      workerId: "worker-1",
      toolId: "tool.read_workspace",
      inputSummary: "Read package metadata"
    } as const;
    const toolCallCompletedPayload = {
      toolCallId: "tool-call-1",
      statusKind: "success",
      outputSummary: "Read completed",
      durationMs: 42
    } as const;
    const toolCallCompletedPayloadWithAffectedPaths = {
      ...toolCallCompletedPayload,
      affected_paths: ["src/index.ts", "docs/README.md"]
    } as const;
    const toolCallCompletedPayloadWithNullAffectedPaths = {
      ...toolCallCompletedPayload,
      affected_paths: null
    } as const;
    const toolCallCompletedPayloadWithEmptyAffectedPaths = {
      ...toolCallCompletedPayload,
      affected_paths: []
    } as const;
    const workerStateChangedPayload = {
      workerId: "worker-1",
      state: "suspended",
      previousState: "active",
      suspendReason: "lease_cascade",
      returnedObjectRefs: ["slot-1"],
      rollbackAttempted: true
    } as const;
    const workerStateActivatedFromInitPayload = {
      workerId: "worker-2",
      state: "active",
      previousState: "init"
    } as const;
    const governanceSpamFaultPayload = {
      runId: "run-1",
      nodeId: "node-1",
      faultSummary: "Repeated spam-like signal emissions detected."
    } as const;

    expect(parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_INTENT_CREATED, toolIntentCreatedPayload)).toEqual(
      toolIntentCreatedPayload
    );
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_INTENT_APPROVED, toolIntentApprovedPayload)).toEqual(
      toolIntentApprovedPayload
    );
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_INTENT_DENIED, toolIntentDeniedPayload)).toEqual(
      toolIntentDeniedPayload
    );
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_STARTED, toolCallStartedPayload)).toEqual(
      toolCallStartedPayload
    );
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_COMPLETED, toolCallCompletedPayload)).toEqual(
      toolCallCompletedPayload
    );
    expect(
      parseToolWorkerEventPayload(
        ToolWorkerEventType.TOOL_CALL_COMPLETED,
        toolCallCompletedPayloadWithAffectedPaths
      )
    ).toEqual(toolCallCompletedPayloadWithAffectedPaths);
    expect(
      parseToolWorkerEventPayload(
        ToolWorkerEventType.TOOL_CALL_COMPLETED,
        toolCallCompletedPayloadWithNullAffectedPaths
      )
    ).toEqual(toolCallCompletedPayloadWithNullAffectedPaths);
    expect(
      parseToolWorkerEventPayload(
        ToolWorkerEventType.TOOL_CALL_COMPLETED,
        toolCallCompletedPayloadWithEmptyAffectedPaths
      )
    ).toEqual(toolCallCompletedPayloadWithEmptyAffectedPaths);
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, workerStateChangedPayload)).toEqual(
      workerStateChangedPayload
    );
    expect(
      parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, workerStateActivatedFromInitPayload)
    ).toEqual(workerStateActivatedFromInitPayload);
    expect(parseToolWorkerEventPayload(ToolWorkerEventType.GOVERNANCE_SPAM_FAULT, governanceSpamFaultPayload)).toEqual(
      governanceSpamFaultPayload
    );

    expect(ToolCallStartedPayloadSchema.parse(toolCallStartedPayload)).toEqual(toolCallStartedPayload);
    expect(WorkerStateChangedPayloadSchema.parse(workerStateChangedPayload)).toEqual(workerStateChangedPayload);
    expect(WorkerStateChangedPayloadSchema.parse(workerStateActivatedFromInitPayload)).toEqual(
      workerStateActivatedFromInitPayload
    );

    expect(
      ToolWorkerEventUnionSchema.parse({
        type: ToolWorkerEventType.WORKER_STATE_CHANGED,
        payload: workerStateChangedPayload
      })
    ).toEqual({
      type: ToolWorkerEventType.WORKER_STATE_CHANGED,
      payload: workerStateChangedPayload
    });
    expect(
      ToolWorkerEventUnionSchema.parse({
        type: ToolWorkerEventType.TOOL_CALL_STARTED,
        payload: toolCallStartedPayload
      })
    ).toEqual({
      type: ToolWorkerEventType.TOOL_CALL_STARTED,
      payload: toolCallStartedPayload
    });
    expect(
      ToolWorkerEventUnionSchema.parse({
        type: ToolWorkerEventType.GOVERNANCE_SPAM_FAULT,
        payload: governanceSpamFaultPayload
      })
    ).toEqual({
      type: ToolWorkerEventType.GOVERNANCE_SPAM_FAULT,
      payload: governanceSpamFaultPayload
    });

    expect(EventTypeSchema.parse(ToolWorkerEventType.WORKER_STATE_CHANGED)).toBe(ToolWorkerEventType.WORKER_STATE_CHANGED);
    expect(EventTypeSchema.parse(ToolWorkerEventType.TOOL_CALL_STARTED)).toBe(ToolWorkerEventType.TOOL_CALL_STARTED);
    expect(EventTypeSchema.parse(ToolWorkerEventType.TOOL_CALL_COMPLETED)).toBe(ToolWorkerEventType.TOOL_CALL_COMPLETED);
    expect(EventTypeSchema.parse(ToolWorkerEventType.GOVERNANCE_SPAM_FAULT)).toBe(
      ToolWorkerEventType.GOVERNANCE_SPAM_FAULT
    );
  });

  it("rejects retired names, omitted required fields, and invalid A1 payloads", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const EventTypeSchema = protocol.EventTypeSchema as ParseableSchema;
    const ToolWorkerEventType = protocol.ToolWorkerEventType as Record<string, string>;
    const ToolWorkerEventTypeSchema = protocol.ToolWorkerEventTypeSchema as ParseableSchema;
    const parseToolWorkerEventPayload = protocol.parseToolWorkerEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    expect(() => EventTypeSchema.parse("tool.execution.started")).toThrow();
    expect(() => EventTypeSchema.parse("run.worker.dispatched")).toThrow();
    expect(() => EventTypeSchema.parse("tool.governance.spam_fault")).toThrow();
    expect(() => ToolWorkerEventTypeSchema.parse("tool.execution.started")).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_COMPLETED, {
        toolCallId: "tool-call-1",
        statusKind: "success"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_COMPLETED, {
        toolCallId: "tool-call-1",
        statusKind: "partial",
        durationMs: 42
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_COMPLETED, {
        toolCallId: "tool-call-1",
        statusKind: "success",
        durationMs: 42,
        affected_paths: ["/tmp/escape.txt"]
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_CALL_COMPLETED, {
        toolCallId: "tool-call-1",
        statusKind: "success",
        durationMs: 42,
        affected_paths: [""]
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, {
        workerId: "worker-1",
        state: "active"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, {
        workerId: "worker-1",
        state: "suspended",
        previousState: "active",
        suspendReason: "manual_pause"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, {
        workerId: "worker-1",
        state: "init",
        previousState: "active"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.WORKER_STATE_CHANGED, {
        workerId: "worker-1",
        state: "active",
        previousState: "init",
        suspendReason: "lease_cascade"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.GOVERNANCE_SPAM_FAULT, {
        runId: "run-1",
        nodeId: "node-1"
      })
    ).toThrow();

    expect(() =>
      parseToolWorkerEventPayload(ToolWorkerEventType.TOOL_INTENT_DENIED, {
        executionId: "exec-2",
        governanceDecisionRef: "decision-2",
        hardConstraintsPresent: true
      })
    ).toThrow();
  });
});
