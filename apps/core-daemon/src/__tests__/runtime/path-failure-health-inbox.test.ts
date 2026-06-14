import { afterEach, describe, expect, it } from "vitest";
import {
  HealthIssueCauseKind,
  HealthIssueResolutionState,
  HealthIssueSeverity,
  HealthIssueSuggestedAction
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteHealthIssueGroupRepo
} from "@do-soul/alaya-storage";
import { createPathFailureHealthInbox } from "../../runtime/daemon-service-wiring.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("path failure health inbox wiring", () => {
  it("records path relation failures as grouped HealthIssueGroup rows", () => {
    const { repo, inbox } = createInboxContext();

    inbox.recordPathRelationFailure({
      workspaceId: "workspace-1",
      targetObjectId: "memory-1",
      observedAt: "2026-06-14T00:00:00.000Z"
    });
    inbox.recordPathRelationFailure({
      workspaceId: "workspace-1",
      targetObjectId: "memory-1",
      observedAt: "2026-06-14T00:01:00.000Z"
    });
    inbox.recordPathRelationFailure({
      workspaceId: "workspace-1",
      targetObjectId: "memory-2",
      observedAt: "2026-06-14T00:02:00.000Z"
    });
    inbox.recordPathRelationFailure({
      workspaceId: "workspace-2",
      targetObjectId: "memory-1",
      observedAt: "2026-06-14T00:03:00.000Z"
    });

    const grouped = repo.findByCompositeKey(
      "workspace-1",
      "memory-1",
      HealthIssueCauseKind.PATH_RELATION_FAILURE
    );
    expect(grouped).toMatchObject({
      workspace_id: "workspace-1",
      target_object_id: "memory-1",
      target_object_kind: "memory_entry",
      cause_kind: HealthIssueCauseKind.PATH_RELATION_FAILURE,
      severity: HealthIssueSeverity.WARN,
      confidence: 1,
      first_seen_at: "2026-06-14T00:00:00.000Z",
      last_seen_at: "2026-06-14T00:01:00.000Z",
      count: 2,
      suggested_actions: [HealthIssueSuggestedAction.INSPECT_PATH_FAILURE],
      resolution_state: HealthIssueResolutionState.PENDING,
      resolved_at: null,
      resolved_by: null
    });

    expect(
      repo.findByWorkspace("workspace-1", {
        state: HealthIssueResolutionState.PENDING,
        causeKind: HealthIssueCauseKind.PATH_RELATION_FAILURE
      }).map((group) => group.target_object_id)
    ).toEqual(["memory-2", "memory-1"]);
    expect(
      repo.findByWorkspace("workspace-2", {
        state: HealthIssueResolutionState.PENDING,
        causeKind: HealthIssueCauseKind.PATH_RELATION_FAILURE
      }).map((group) => group.target_object_id)
    ).toEqual(["memory-1"]);

    repo.markResolved(
      grouped!.group_id,
      "operator-1",
      "2026-06-14T00:04:00.000Z"
    );

    expect(
      repo.findByWorkspace("workspace-1", {
        state: HealthIssueResolutionState.PENDING,
        causeKind: HealthIssueCauseKind.PATH_RELATION_FAILURE
      }).map((group) => group.target_object_id)
    ).toEqual(["memory-2"]);
    expect(
      repo.findByWorkspace("workspace-1", {
        state: HealthIssueResolutionState.RESOLVED,
        causeKind: HealthIssueCauseKind.PATH_RELATION_FAILURE
      }).map((group) => group.target_object_id)
    ).toEqual(["memory-1"]);
  });
});

function createInboxContext(): {
  readonly repo: SqliteHealthIssueGroupRepo;
  readonly inbox: ReturnType<typeof createPathFailureHealthInbox>;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const repo = new SqliteHealthIssueGroupRepo(database);
  return {
    repo,
    inbox: createPathFailureHealthInbox({ healthIssueGroupRepo: repo })
  };
}
