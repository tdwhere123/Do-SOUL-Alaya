import { afterEach, describe, expect, it } from "vitest";
import {
  HealthIssueCauseKind,
  HealthIssueResolutionState,
  HealthIssueSeverity
} from "@do-soul/alaya-protocol";
import { wrapRecallFaultWarn } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteHealthIssueGroupRepo
} from "@do-soul/alaya-storage";
import { createRecallFailureHealthInbox } from "../../runtime/daemon-service-wiring.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("recall failure health inbox wiring", () => {
  it("groups recall auxiliary failures by (workspace, operation)", () => {
    const { repo, inbox } = createInboxContext();

    inbox.recordRecallFailure({
      workspaceId: "workspace-1",
      operation: "graph_support_lookup",
      observedAt: "2026-06-14T00:00:00.000Z"
    });
    inbox.recordRecallFailure({
      workspaceId: "workspace-1",
      operation: "graph_support_lookup",
      observedAt: "2026-06-14T00:01:00.000Z"
    });
    inbox.recordRecallFailure({
      workspaceId: "workspace-1",
      operation: "path_plasticity_factors",
      observedAt: "2026-06-14T00:02:00.000Z"
    });
    inbox.recordRecallFailure({
      workspaceId: "workspace-2",
      operation: "graph_support_lookup",
      observedAt: "2026-06-14T00:03:00.000Z"
    });

    expect(
      repo.findByCompositeKey(
        "workspace-1",
        "graph_support_lookup",
        HealthIssueCauseKind.RECALL_AUXILIARY_FAILURE
      )
    ).toMatchObject({
      workspace_id: "workspace-1",
      target_object_id: "graph_support_lookup",
      target_object_kind: "recall_operation",
      cause_kind: HealthIssueCauseKind.RECALL_AUXILIARY_FAILURE,
      severity: HealthIssueSeverity.WARN,
      first_seen_at: "2026-06-14T00:00:00.000Z",
      last_seen_at: "2026-06-14T00:01:00.000Z",
      count: 2,
      suggested_actions: [],
      resolution_state: HealthIssueResolutionState.PENDING
    });

    expect(
      repo
        .findByWorkspace("workspace-1", {
          state: HealthIssueResolutionState.PENDING,
          causeKind: HealthIssueCauseKind.RECALL_AUXILIARY_FAILURE
        })
        .map((group) => group.target_object_id)
        .sort()
    ).toEqual(["graph_support_lookup", "path_plasticity_factors"]);
  });

  it("routes only unexpected errors through the fault-aware warn", async () => {
    const { repo, inbox } = createInboxContext();
    const warnCalls: string[] = [];
    const warn = wrapRecallFaultWarn(
      (message) => warnCalls.push(message),
      inbox,
      "workspace-1",
      () => "2026-06-14T00:00:00.000Z"
    );

    warn("graph support lookup failed", {
      operation: "graph_support_lookup",
      errorName: "TypeError"
    });
    warn("path plasticity port lookup failed", {
      operation: "path_plasticity_factors",
      errorName: "CoreError"
    });
    await Promise.resolve();

    // Both warns always log...
    expect(warnCalls).toEqual([
      "graph support lookup failed",
      "path plasticity port lookup failed"
    ]);
    // ...but only the unexpected (TypeError) one lands a health group.
    expect(
      repo.findByCompositeKey(
        "workspace-1",
        "graph_support_lookup",
        HealthIssueCauseKind.RECALL_AUXILIARY_FAILURE
      )?.count
    ).toBe(1);
    expect(
      repo.findByCompositeKey(
        "workspace-1",
        "path_plasticity_factors",
        HealthIssueCauseKind.RECALL_AUXILIARY_FAILURE
      )
    ).toBeNull();
  });
});

function createInboxContext(): {
  readonly repo: SqliteHealthIssueGroupRepo;
  readonly inbox: ReturnType<typeof createRecallFailureHealthInbox>;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const repo = new SqliteHealthIssueGroupRepo(database);
  return {
    repo,
    inbox: createRecallFailureHealthInbox({ healthIssueGroupRepo: repo })
  };
}
