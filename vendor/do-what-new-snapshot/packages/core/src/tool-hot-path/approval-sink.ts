import type { ApprovalSinkPort } from "./hot-path-full.js";
import type { CircuitBreaker } from "./circuit-breaker.js";

export interface ApprovalSinkDependencies {
  readonly circuitBreaker: Pick<CircuitBreaker, "recordOutcome" | "getState">;
  readonly approvalResolver?: (
    executionId: string,
    toolId: string,
    reason: string
  ) => Promise<"approved" | "denied">;
  readonly runId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly governanceSubjectKey: string;
}

export class ApprovalSink implements ApprovalSinkPort {
  public constructor(private readonly deps: ApprovalSinkDependencies) {}

  public async requestApproval(
    executionId: string,
    toolId: string,
    reason: string
  ): Promise<"approved" | "denied"> {
    const resolver = this.deps.approvalResolver ?? (async () => "denied" as const);
    const decision = await resolver(executionId, toolId, reason);

    try {
      await this.deps.circuitBreaker.recordOutcome(
        this.deps.runId,
        this.deps.workspaceId,
        this.deps.nodeId,
        this.deps.governanceSubjectKey,
        decision === "denied" ? "deny" : "ask"
      );
    } catch {
      // Approval remains authoritative even if breaker telemetry fails.
    }

    return decision;
  }
}
