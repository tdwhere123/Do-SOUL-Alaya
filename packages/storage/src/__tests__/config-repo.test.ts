import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";
import { SqliteConfigRepo } from "../repos/config-repo.js";

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

    await repo.set("workspace:ws-1:soul", {
      memory_consolidation_enabled: true,
      local_heuristics_enabled: false,
      garden_backlog_soft_limit: 42,
      memory_hard_cap: 500,
      auto_checkpoint: true
    });

    await expect(repo.get("workspace:ws-1:soul")).resolves.toEqual({
      memory_consolidation_enabled: true,
      local_heuristics_enabled: false,
      garden_backlog_soft_limit: 42,
      memory_hard_cap: 500,
      auto_checkpoint: true
    });
  });

  it("returns null when a config key is missing", async () => {
    const repo = createRepo();

    await expect(repo.get("workspace:missing:strategy")).resolves.toBeNull();
  });

  it("patches shallowly against defaults when the key does not yet exist", async () => {
    const repo = createRepo();

    await expect(
      repo.patch(
        "workspace:ws-1:strategy",
        {
          auto_approve_readonly: true
        },
        {
          require_bash_approval: true,
          require_write_approval: true,
          require_network_approval: true,
          auto_approve_readonly: false
        }
      )
    ).resolves.toEqual({
      require_bash_approval: true,
      require_write_approval: true,
      require_network_approval: true,
      auto_approve_readonly: true
    });
  });

  it("patches shallowly onto an existing config object", async () => {
    const repo = createRepo();

    await repo.set("workspace:ws-1:environment", {
      env_vars: {
        NODE_ENV: "development"
      },
      worktree_enabled: false
    });

    await expect(
      repo.patch(
        "workspace:ws-1:environment",
        {
          worktree_enabled: true
        },
        {
          env_vars: {},
          worktree_enabled: false
        }
      )
    ).resolves.toEqual({
      env_vars: {
        NODE_ENV: "development"
      },
      worktree_enabled: true
    });
  });
});

function createRepo(): SqliteConfigRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteConfigRepo(database);
}
