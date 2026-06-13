import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HealthInboxPage from "../HealthInbox";
import { ToastProvider } from "../../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../../api";

function renderHealthInbox() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <HealthInboxPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeGroup(overrides: Partial<HealthIssueGroupShape>): HealthIssueGroupShape {
  return {
    group_id: "g-1",
    workspace_id: "ws1",
    target_object_id: "mem-1",
    target_object_kind: "memory_entry",
    cause_kind: "orphan_radar",
    severity: "warn",
    confidence: 0.75,
    first_seen_at: "2026-05-10T00:00:00.000Z",
    last_seen_at: "2026-05-15T00:00:00.000Z",
    count: 3,
    suggested_actions: ["relink", "retire_memory"],
    resolution_state: "pending",
    resolved_at: null,
    resolved_by: null,
    ...overrides
  };
}

interface HealthIssueGroupShape {
  readonly group_id: string;
  readonly workspace_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly cause_kind: "orphan_radar" | "green_revoked" | "evidence_failure";
  readonly severity: "info" | "warn" | "blocking";
  readonly confidence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly count: number;
  readonly suggested_actions: readonly string[];
  readonly resolution_state: "pending" | "resolved" | "suppressed";
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

describe("HealthInboxPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("renders at least 5 grouped entries from a fresh DB payload", async () => {
    const groups: HealthIssueGroupShape[] = [
      makeGroup({ group_id: "g-1", target_object_id: "mem-1", cause_kind: "orphan_radar" }),
      makeGroup({ group_id: "g-2", target_object_id: "mem-2", cause_kind: "orphan_radar", severity: "info", count: 1 }),
      makeGroup({
        group_id: "g-3",
        target_object_id: "mem-3",
        cause_kind: "green_revoked",
        severity: "blocking",
        suggested_actions: ["request_evidence"],
        count: 4
      }),
      makeGroup({
        group_id: "g-4",
        target_object_id: "mem-4",
        cause_kind: "evidence_failure",
        severity: "warn",
        suggested_actions: ["review_proposal"],
        count: 2
      }),
      makeGroup({
        group_id: "g-5",
        target_object_id: "mem-5",
        cause_kind: "evidence_failure",
        severity: "info",
        count: 1
      })
    ];
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/workspaces/ws1/health-inbox")) {
        return jsonResponse({
          success: true,
          data: { workspace_id: "ws1", groups, total_count: groups.length }
        });
      }
      return jsonResponse({}, 404);
    });

    renderHealthInbox();

    await waitFor(() =>
      expect(screen.getAllByTestId("health-inbox-group").length).toBeGreaterThanOrEqual(5)
    );
    // groupedByCause produces three cause buckets above
    expect(screen.getByText(/orphan radar|孤儿雷达/i)).toBeTruthy();
    expect(screen.getByText(/green revoked|Green 撤销/i)).toBeTruthy();
    expect(screen.getByText(/evidence failure|证据失败/i)).toBeTruthy();
  });

  it("forwards the state filter to the daemon route", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { workspace_id: "ws1", groups: [], total_count: 0 } })
    );
    renderHealthInbox();
    await waitFor(() => {
      const called = fetchMock.mock.calls.some((call) => {
        const url = urlOf(call[0] as FetchInput);
        return url.includes("/workspaces/ws1/health-inbox") && url.includes("state=pending");
      });
      expect(called).toBe(true);
    });
  });

  it("renders the empty-state when the daemon returns zero groups", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { workspace_id: "ws1", groups: [], total_count: 0 } })
    );
    renderHealthInbox();
    await waitFor(() =>
      expect(
        screen.getByText(/No health issues|无健康问题/i)
      ).toBeTruthy()
    );
  });
});
