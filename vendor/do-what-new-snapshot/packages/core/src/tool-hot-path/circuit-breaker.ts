import type { EventLogEntry, ToolCategory } from "@do-what/protocol";
import { GovernanceSpamFaultPayloadSchema, PhaseA1EventType } from "@do-what/protocol";
import { deepFreeze } from "../shared/deep-freeze.js";
import { CURRENT_TOOL_EVENT_REVISION } from "./shared-execution.js";

const DEGRADED_CATEGORY_ORDER: readonly ToolCategory[] = ["exec", "write", "network", "memory"];

export interface CircuitBreakerConfig {
  readonly spamThreshold: number;
  readonly windowMs: number;
}

export interface CircuitBreakerState {
  readonly postureLevel: 0 | 1 | 2;
  readonly additionalDeniedCategories: readonly ToolCategory[];
  readonly cooldownUntil: string | null;
}

export interface CircuitBreakerEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface CircuitBreakerSseBroadcasterPort {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface CircuitBreakerDependencies {
  readonly config: CircuitBreakerConfig;
  readonly eventLogRepo: CircuitBreakerEventLogRepoPort;
  readonly sseBroadcaster: CircuitBreakerSseBroadcasterPort;
  readonly now?: () => string;
}

export class CircuitBreaker {
  private readonly outcomeHistory = new Map<string, number[]>();
  private state: CircuitBreakerState = deepFreeze({
    postureLevel: 0,
    additionalDeniedCategories: [],
    cooldownUntil: null
  });

  public constructor(private readonly deps: CircuitBreakerDependencies) {}

  public async recordOutcome(
    runId: string,
    workspaceId: string,
    nodeId: string,
    governanceSubjectKey: string,
    outcome: "ask" | "deny"
  ): Promise<void> {
    const nowIso = this.now();
    this.normalizeState(nowIso);
    const nowMs = Date.parse(nowIso);
    const threshold = Math.max(1, this.deps.config.spamThreshold);
    const windowMs = Math.max(0, this.deps.config.windowMs);
    const windowStart = nowMs - windowMs;

    this.evictStaleSubjects(nowMs, windowMs);

    const history = this.outcomeHistory.get(governanceSubjectKey) ?? [];
    const retained = history.filter((timestamp) => timestamp >= windowStart);
    const nextHistory = [...retained, nowMs];

    this.outcomeHistory.set(governanceSubjectKey, nextHistory);

    const crossedThreshold = retained.length < threshold && nextHistory.length >= threshold;
    if (!crossedThreshold) {
      return;
    }

    this.state = this.nextState(nowIso);
    const appended = await this.deps.eventLogRepo.append({
      event_type: PhaseA1EventType.GOVERNANCE_SPAM_FAULT,
      entity_type: "tool_execution",
      entity_id: `${governanceSubjectKey}:${nowMs}`,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: outcome,
      revision: CURRENT_TOOL_EVENT_REVISION,
      payload_json: deepFreeze(
        GovernanceSpamFaultPayloadSchema.parse({
          runId,
          nodeId,
          faultSummary: `${nextHistory.length} ask/deny outcomes in ${this.deps.config.windowMs}ms window for subject ${governanceSubjectKey}`
        })
      )
    });
    await this.deps.sseBroadcaster.broadcastEntry(appended);
  }

  public getState(): Readonly<CircuitBreakerState> {
    this.normalizeState(this.now());
    return this.state;
  }

  private evictStaleSubjects(nowMs: number, windowMs: number): void {
    const staleBefore = nowMs - windowMs * 2;

    for (const [subjectKey, history] of this.outcomeHistory.entries()) {
      const latestTimestamp = history[history.length - 1];

      if (latestTimestamp === undefined || latestTimestamp < staleBefore) {
        this.outcomeHistory.delete(subjectKey);
      }
    }
  }

  private nextState(nowIso: string): CircuitBreakerState {
    const cooldownUntil = new Date(Date.parse(nowIso) + Math.max(0, this.deps.config.windowMs)).toISOString();

    switch (this.state.postureLevel) {
      case 0:
        return deepFreeze({
          postureLevel: 1,
          additionalDeniedCategories: [...this.state.additionalDeniedCategories],
          cooldownUntil
        });
      case 1:
        return deepFreeze({
          postureLevel: 2,
          additionalDeniedCategories: [...this.state.additionalDeniedCategories],
          cooldownUntil
        });
      case 2: {
        const nextCategory = DEGRADED_CATEGORY_ORDER.find(
          (category) => !this.state.additionalDeniedCategories.includes(category)
        );

        return deepFreeze({
          postureLevel: 2,
          additionalDeniedCategories:
            nextCategory === undefined
              ? [...this.state.additionalDeniedCategories]
              : [...this.state.additionalDeniedCategories, nextCategory],
          cooldownUntil
        });
      }
      default:
        return assertNever(this.state.postureLevel);
    }
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private normalizeState(nowIso: string): void {
    if (this.state.cooldownUntil === null) {
      return;
    }

    const nowMs = Date.parse(nowIso);
    const cooldownMs = Date.parse(this.state.cooldownUntil);

    if (!Number.isFinite(nowMs) || !Number.isFinite(cooldownMs) || nowMs < cooldownMs) {
      return;
    }

    this.outcomeHistory.clear();
    this.state = deepFreeze({
      postureLevel: 0,
      additionalDeniedCategories: [],
      cooldownUntil: null
    });
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled circuit-breaker posture level: ${String(value)}`);
}
