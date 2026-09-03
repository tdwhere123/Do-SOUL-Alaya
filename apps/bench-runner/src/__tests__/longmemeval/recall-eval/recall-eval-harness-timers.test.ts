import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcHost,
  type RecallEvalPagerIpcProcess
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/ipc-client.js";
import { writeRecallEvalProgress } from
  "../../../runs/lifecycle/recall-eval/recall-eval-progress.js";
import type { RecallEvalHarnessTimers } from
  "../../../runs/lifecycle/recall-eval/recall-eval-contract.js";

const sessions: ReturnType<typeof createRecallEvalPagerSession>[] = [];

afterEach(async () => {
  const pending = sessions.splice(0);
  await Promise.all(pending.map((session) => session.close().catch(() => undefined)));
  vi.restoreAllMocks();
});

describe("recall-eval harness timers", () => {
  it("omits clockAMs and harnessOverheadMs when pack.latencyMs is missing", async () => {
    const timers = await recallTimers({});
    expect(timers.totalWallMs).toBeGreaterThanOrEqual(0);
    expect("clockAMs" in timers).toBe(false);
    expect("harnessOverheadMs" in timers).toBe(false);
  });

  it("omits clockAMs when pack.latencyMs is not a finite number", async () => {
    for (const latencyMs of [Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
      const timers = await recallTimers({ latencyMs });
      expect("clockAMs" in timers).toBe(false);
      expect("harnessOverheadMs" in timers).toBe(false);
      expect(Number.isFinite(timers.totalWallMs)).toBe(true);
    }
  });

  it("keeps a measured Clock-A of 0 and does not treat it as unknown", async () => {
    const timers = await recallTimers({ latencyMs: 0 });
    expect(timers.clockAMs).toBe(0);
    expect(timers.harnessOverheadMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(timers.harnessOverheadMs)).toBe(true);
  });

  it("computes overhead from a finite Clock-A without substituting 0", async () => {
    const timers = await recallTimers({ latencyMs: 12 });
    expect(timers.clockAMs).toBe(12);
    expect(timers.harnessOverheadMs).toBe(Math.max(0, timers.totalWallMs - 12));
  });

  it("prints wall without inventing overhead=0 when Clock-A is unknown", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeRecallEvalProgress(0, 1, "question-id", {
      hitAt5: true,
      latencyMs: 8,
      harnessTimers: { openDurationMs: 1, recallDurationMs: 2, totalWallMs: 3 }
    });
    expect(String(stdout.mock.calls[0]?.[0])).toContain("wall=3ms");
    expect(String(stdout.mock.calls[0]?.[0])).not.toContain("overhead=");
  });

  it("prints overhead only when the timer claim is numeric", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeRecallEvalProgress(0, 1, "question-id", {
      hitAt5: false,
      latencyMs: 8,
      harnessTimers: {
        openDurationMs: 1,
        recallDurationMs: 2,
        totalWallMs: 4,
        clockAMs: 3,
        harnessOverheadMs: 1
      }
    });
    expect(String(stdout.mock.calls[0]?.[0])).toContain(
      "wall=4ms, overhead=1ms"
    );
  });
});

async function recallTimers(
  packFields: Record<string, unknown>
): Promise<RecallEvalHarnessTimers> {
  const session = createRecallEvalPagerSession({ host: packHost(packFields) });
  sessions.push(session);
  await session.open({});
  const pack = await session.recall({ questionId: "q1" }) as {
    readonly harnessTimers: RecallEvalHarnessTimers;
  };
  return pack.harnessTimers;
}

function packHost(packFields: Record<string, unknown>): RecallEvalPagerIpcHost {
  let nextPid = 8000;
  return {
    spawn(): RecallEvalPagerIpcProcess {
      const pid = nextPid += 1;
      const listeners = new Map<string, Array<(...args: never[]) => void>>();
      const child: RecallEvalPagerIpcProcess = {
        pid,
        send(message, callback) {
          const request = message as { readonly id: number; readonly op: string };
          queueMicrotask(() => {
            emit(listeners, "message", reply(request, packFields, pid));
          });
          callback?.(null);
          return true;
        },
        on(event, listener) {
          const current = listeners.get(event) ?? [];
          current.push(listener as (...args: never[]) => void);
          listeners.set(event, current);
          return child;
        },
        kill() {
          return true;
        }
      };
      return child;
    }
  };
}

function reply(
  request: { readonly id: number; readonly op: string },
  packFields: Record<string, unknown>,
  pid: number
): unknown {
  if (request.op === "recall") {
    return {
      id: request.id,
      ok: true,
      pid,
      pack: {
        questionId: "q1",
        diagnostics: {},
        ...packFields
      }
    };
  }
  return { id: request.id, ok: true, pid };
}

function emit(
  listeners: Map<string, Array<(...args: never[]) => void>>,
  event: string,
  message: unknown
): void {
  for (const listener of listeners.get(event) ?? []) {
    (listener as (value: unknown) => void)(message);
  }
}
