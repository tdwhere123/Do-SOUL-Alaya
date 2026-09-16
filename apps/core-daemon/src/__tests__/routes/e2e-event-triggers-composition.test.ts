import { describe, expect, it, vi, afterEach } from "vitest";
import { createApp } from "../../runtime/app.js";
import { shouldEnableE2eEventTriggers } from "../../runtime/daemon/wiring/daemon-app-composition.js";
import { E2E_EVENT_TRIGGER_TOKEN_HEADER } from "../../routes/workspace/e2e-event-triggers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("e2e EventLog inject composition", () => {
  it("returns 404 outside NODE_ENV=test even when the opt-in flag is set", async () => {
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "development",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "1",
        ALAYA_E2E_EVENT_TRIGGER_TOKEN: "e2e-token"
      })
    ).toBe(false);

    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost",
        requestToken: "test-token",
        allowDesktopOriginlessRequests: true
      }
    });
    const response = await app.request("/__e2e/events/soul-approval-requested", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-token": "test-token",
        "x-alaya-desktop": "1",
        [E2E_EVENT_TRIGGER_TOKEN_HEADER]: "e2e-token"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });
    expect(response.status).toBe(404);
  });

  it("still 404s when a process token is present but inject routes were not composed", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost",
        requestToken: "test-token",
        allowDesktopOriginlessRequests: true
      },
      routes: {
        e2eEventTriggers: undefined
      }
    });
    const response = await app.request("/__e2e/events/dirty-state-panic", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-token": "test-token",
        "x-alaya-desktop": "1",
        [E2E_EVENT_TRIGGER_TOKEN_HEADER]: "e2e-token"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });
    expect(response.status).toBe(404);
  });

  it("does not treat the process token as the e2e inject credential", async () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = vi.fn();
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost",
        requestToken: "process-token",
        allowDesktopOriginlessRequests: true
      },
      routes: {
        e2eEventTriggers: {
          triggerToken: "e2e-token",
          runService: { getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "ws" })) },
          workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws" })) },
          eventLogRepo: { append },
          runtimeNotifier: { notifyEntry: vi.fn() }
        }
      }
    });
    const processOnly = await app.request("/__e2e/events/soul-approval-requested", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-token": "process-token",
        "x-alaya-desktop": "1"
      },
      body: JSON.stringify({ run_id: "run-1" })
    });
    expect(processOnly.status).toBe(403);
    expect(append).not.toHaveBeenCalled();
  });
});
