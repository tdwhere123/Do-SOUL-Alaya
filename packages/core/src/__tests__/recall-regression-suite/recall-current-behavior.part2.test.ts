import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { capableRecallConsumerDeclaration, RecallService } from "../../recall/recall-service.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "../recall/recall-service-test-fixtures.js";
import { createClaimForm } from "../governance/claim-service.test-support.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });
const fixture = () => createSourceBoundRecallFixture((database) => databases.add(database));
const request = () => ({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
  strategy: "analyze" as const, queryText: "deployment checklist" });

describe("retained temporal probes and active constraints contract", () => {
  it.each(["What changed yesterday?", "上周做了什么决定？"])("recognizes a temporal concern in %s", (query) => {
    expect(compileRecallQueryProbes(query).date_terms.length).toBeGreaterThan(0);
  });
  it.each(["recall release checklist", "召回发布检查项"])("does not fabricate a temporal concern in %s", (query) => {
    expect(compileRecallQueryProbes(query).date_terms).toEqual([]);
  });

  it("returns active constraints outside the structured result page budget", async () => {
    const f = await fixture();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
    await f.writeMemory(id, "deployment checklist", "procedure");
    const constraintId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
    await f.writeMemory(constraintId, "Never publish private material", "constraint");
    await f.claimFormRepo.create(createClaimForm({ workspace_id: "workspace-1", claim_status: "active",
      source_object_refs: [constraintId] }));
    const result = await f.service.recall({ ...request(), pageBudget: 1 });
    expect(result.candidates.map((entry) => entry.object_id)).toEqual([id]);
    expect(result.active_constraints.map((entry) => entry.object_id)).toEqual([constraintId]);
  });

  it("reports the active constraints total independently of the delivered cap", async () => {
    const f = await fixture();
    for (let offset = 0; offset < 7; offset += 1) {
      await f.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`,
        "Never publish private material", "constraint");
      await f.claimFormRepo.create(createClaimForm({
        object_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(offset).padStart(12, "0")}`,
        workspace_id: "workspace-1", claim_status: "active",
        source_object_refs: [`aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`]
      }));
    }
    const result = await f.service.recall({ ...request(), activeConstraintsCap: 0 });
    expect(result.active_constraints).toEqual([]);
    expect(result.active_constraints_count).toBe(7);
  });

  it("passes workspace, cap and explicit interpretation time to the constraint owner", async () => {
    const f = await fixture();
    const readBounded = vi.fn(f.dependencies.activeConstraintsPort!.readBounded!);
    await new RecallService({ ...f.dependencies, activeConstraintsPort: {
      ...f.dependencies.activeConstraintsPort!, readBounded
    } })
      .recall({ ...capableRecallConsumerDeclaration(), ...request(), activeConstraintsCap: 3, referenceTime: "2026-08-22T12:00:00.000Z" });
    expect(readBounded).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", cap: 3,
      asOf: "2026-08-22T12:00:00.000Z", snapshotId: expect.stringMatching(/^sha256:/),
      nativeLimit: expect.any(Number), byteLimit: expect.any(Number) }));
    expect(readBounded.mock.calls[0]![0].nativeLimit).toBeGreaterThan(0);
    expect(readBounded.mock.calls[0]![0].byteLimit).toBeGreaterThan(0);
  });
});
