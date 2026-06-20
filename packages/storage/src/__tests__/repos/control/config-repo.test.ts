import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceCreatedPayloadSchema,
  WorkspaceKind
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteConfigRepo } from "../../../repos/control/config-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteConfigRepo", () => {
  it("stores and reloads typed JSON blobs by key", async () => {
    const repo = createRepo();

    repo.setParsed("workspace:ws-1:soul", {
      memory_consolidation_enabled: true,
      local_heuristics_enabled: false,
      garden_backlog_soft_limit: 42,
      memory_hard_cap: 500,
      auto_checkpoint: true
    }, RecordConfigParser);

    expect(repo.getParsed("workspace:ws-1:soul", RecordConfigParser)).toEqual({
      memory_consolidation_enabled: true,
      local_heuristics_enabled: false,
      garden_backlog_soft_limit: 42,
      memory_hard_cap: 500,
      auto_checkpoint: true
    });
  });

  it("returns null when a config key is missing", async () => {
    const repo = createRepo();

    expect(repo.getParsed("workspace:missing:strategy", RecordConfigParser)).toBeNull();
    expect(repo.getParsed("workspace:missing:strategy", WorkspaceCreatedPayloadSchema)).toBeNull();
  });

  it("parses stored config through a caller-provided schema", async () => {
    const repo = createRepo();

    repo.setParsed("runtime:typed", {
      workspace_id: "workspace-1",
      name: "typed workspace",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    }, WorkspaceCreatedPayloadSchema);

    expect(
      repo.getParsed("runtime:typed", WorkspaceCreatedPayloadSchema)
    ).toEqual({
      workspace_id: "workspace-1",
      name: "typed workspace",
      workspace_kind: WorkspaceKind.LOCAL_REPO
    });
  });

  it("fails closed when stored config violates the requested schema", async () => {
    const repo = createRepo();

    repo.setParsed("runtime:typed-invalid", {
      workspace_id: "workspace-1",
      name: "typed workspace",
      workspace_kind: true
    }, RecordConfigParser);

    expect(() =>
      repo.getParsed("runtime:typed-invalid", WorkspaceCreatedPayloadSchema)
    ).toThrowError(expect.objectContaining({ name: "StorageError", code: "QUERY_FAILED" }));
  });

  it("patches shallowly against defaults when the key does not yet exist", async () => {
    const repo = createRepo();

    expect(
      repo.patchParsed<Record<string, unknown>>(
        "workspace:ws-1:strategy",
        {
          auto_approve_readonly: true
        },
        {
          require_bash_approval: true,
          require_write_approval: true,
          require_network_approval: true,
          auto_approve_readonly: false
        },
        RecordConfigParser
      )
    ).toEqual({
      require_bash_approval: true,
      require_write_approval: true,
      require_network_approval: true,
      auto_approve_readonly: true
    });
  });

  it("patches shallowly onto an existing config object", async () => {
    const repo = createRepo();

    repo.setParsed("workspace:ws-1:environment", {
      env_vars: {
        NODE_ENV: "development"
      },
      worktree_enabled: false
    }, RecordConfigParser);

    expect(
      repo.patchParsed<Record<string, unknown>>(
        "workspace:ws-1:environment",
        {
          worktree_enabled: true
        },
        {
          env_vars: {},
          worktree_enabled: false
        },
        RecordConfigParser
      )
    ).toEqual({
      env_vars: {
        NODE_ENV: "development"
      },
      worktree_enabled: true
    });
  });
});

const RecordConfigParser = Object.freeze({
  parse(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Config must be an object");
    }
    return value as Record<string, unknown>;
  }
});

function createRepo(): SqliteConfigRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteConfigRepo(database);
}
