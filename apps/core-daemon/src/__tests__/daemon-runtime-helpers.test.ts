import { afterEach, describe, expect, it, vi } from "vitest";
import { createWarnLogger, reconcileBootstrapPathsForAllWorkspaces } from "../daemon-runtime-helpers.js";

describe("createWarnLogger (pino-backed)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // pino's default (non-TTY) destination is stdout as NDJSON; capture the line.
  function captureWarn(message: string, meta: Record<string, unknown>): Record<string, unknown> {
    const lines: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      });
    try {
      createWarnLogger().warn(message, meta);
    } finally {
      writeSpy.mockRestore();
    }
    const serialized = lines.join("");
    expect(serialized, "expected pino to emit one NDJSON line").not.toBe("");
    return JSON.parse(serialized.trim()) as Record<string, unknown>;
  }

  it("emits structured JSON with message-first → pino object-first arg swap", () => {
    const record = captureWarn("structured warn", { workspace_id: "ws_alpha", count: 3 });
    expect(record.msg).toBe("structured warn");
    expect(record.level).toBe(40); // pino numeric level for warn
    expect(record.workspace_id).toBe("ws_alpha");
    expect(record.count).toBe(3);
  });

  it("redacts top-level and nested secret-bearing fields", () => {
    const record = captureWarn("leak attempt", {
      token: "TOP_SECRET_TOKEN",
      apiKey: "AKIA_TOP",
      authorization: "Bearer top",
      details: {
        password: "nested_pw",
        secret: "nested_secret",
        connectionString: "postgres://user:pw@host/db"
      },
      headers: { authorization: "Bearer nested" },
      keep: "visible"
    });

    expect(record.token).toBe("[Redacted]");
    expect(record.apiKey).toBe("[Redacted]");
    expect(record.authorization).toBe("[Redacted]");
    const details = record.details as Record<string, unknown>;
    expect(details.password).toBe("[Redacted]");
    expect(details.secret).toBe("[Redacted]");
    expect(details.connectionString).toBe("[Redacted]");
    expect((record.headers as Record<string, unknown>).authorization).toBe("[Redacted]");
    // Non-sensitive fields survive, and the raw secret never appears anywhere.
    expect(record.keep).toBe("visible");
    expect(JSON.stringify(record)).not.toContain("TOP_SECRET_TOKEN");
    expect(JSON.stringify(record)).not.toContain("postgres://user:pw@host/db");
  });

  it("redacts nested raw error message fields as defense-in-depth", () => {
    const record = captureWarn("handler failed", {
      error: { message: "raw stack trace with secret", code: "E_BOOM" }
    });
    const error = record.error as Record<string, unknown>;
    expect(error.message).toBe("[Redacted]");
    expect(error.code).toBe("E_BOOM");
  });
});

describe("reconcileBootstrapPathsForAllWorkspaces", () => {
  it("calls reconcileBootstrapPaths for each listed workspace", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => ({
      status: "planted" as const,
      workspace_id: workspaceId,
      paths_planted: 1,
      record_id: `record-${workspaceId}`,
      template_ids: ["template-a"] as const
    }));
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [{ workspace_id: "ws_alpha" }, { workspace_id: "ws_beta" }]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(2);
    expect(reconcileBootstrapPaths).toHaveBeenNthCalledWith(1, "ws_alpha");
    expect(reconcileBootstrapPaths).toHaveBeenNthCalledWith(2, "ws_beta");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reconciles active workspaces only when workspace state is available", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => ({
      status: "already_planted" as const,
      workspace_id: workspaceId,
      record_id: `record-${workspaceId}`,
      relation_count: 1
    }));
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [
          { workspace_id: "ws_active", workspace_state: "active" },
          { workspace_id: "ws_archived", workspace_state: "archived" }
        ]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(1);
    expect(reconcileBootstrapPaths).toHaveBeenCalledWith("ws_active");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs and continues when one workspace's reconcile throws", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "ws_beta") {
        throw new Error("planner_unavailable");
      }
      return {
        status: "already_planted" as const,
        workspace_id: workspaceId,
        record_id: `record-${workspaceId}`,
        relation_count: 1
      };
    });
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [
          { workspace_id: "ws_alpha" },
          { workspace_id: "ws_beta" },
          { workspace_id: "ws_gamma" }
        ]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "bootstrap reconcile failed",
      expect.objectContaining({
        workspace_id: "ws_beta",
        error: "planner_unavailable"
      })
    );
  });

  it("warns and returns silently when workspace enumeration fails", async () => {
    const reconcileBootstrapPaths = vi.fn();
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => {
          throw new Error("db_unavailable");
        }
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "bootstrap reconcile enumeration failed",
      expect.objectContaining({ error: "db_unavailable" })
    );
  });

  it("no-ops cleanly when workspace list is empty", async () => {
    const reconcileBootstrapPaths = vi.fn();
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: { list: async () => [] },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
