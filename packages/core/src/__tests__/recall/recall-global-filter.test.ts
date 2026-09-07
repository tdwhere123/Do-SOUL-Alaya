import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("conditional source scope filtering", () => {
  it("never admits another workspace's otherwise matching source", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    const local = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    const foreign = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
    await f.writeSource({ objectId: local, content: "deployment checklist" });
    await f.writeSource({ objectId: foreign, content: "deployment checklist", workspaceId: "workspace-other" });
    const result = await f.service.recall({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
      strategy: "analyze", queryText: "deployment checklist" });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([local]);
    expect(result.index.entries.some((entry) => entry.object_id === foreign)).toBe(false);
  });

  it("applies declared source scopes to raw observations before index admission", async () => {
    const f = await createSourceBoundRecallFixture((database) => databases.add(database));
    const project = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    const global = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
    await f.writeSource({ objectId: project, content: "deployment checklist", scopeClass: "project" });
    await f.writeSource({ objectId: global, content: "deployment checklist", scopeClass: "global_domain" });
    const policy = f.service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const result = await f.service.recall({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
      strategy: "analyze", queryText: "deployment checklist", policyOverride: {
        ...policy, coarse_filter: { ...policy.coarse_filter, deterministic_match: {
          ...policy.coarse_filter.deterministic_match, scope_filter: ["project"]
        } }
      } });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([project]);
    expect(result.index.entries.some((entry) => entry.object_id === global)).toBe(false);
  });
});
