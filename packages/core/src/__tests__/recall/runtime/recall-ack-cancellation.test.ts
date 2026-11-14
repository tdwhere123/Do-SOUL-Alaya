import { expect, it } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import { capableRecallConsumerDeclaration } from "../../../recall/runtime/recall-consumer-compatibility.js";
import { createDependencies, createTaskSurface } from "../recall-service-test-fixtures.js";

it("rejects a direct in-process deferred delivery callback after the original caller aborts", async () => {
  const service = new RecallService({ ...createDependencies().dependencies, now: () => "2026-09-06T12:00:00.000Z" });
  const controller = new AbortController(), reason = new Error("local delivery caller cancelled");
  const page = await service.recall({ workspaceId: "workspace-1", strategy: "chat", taskSurface: createTaskSurface(),
    queryText: "needle", defer_delivery: true, abortSignal: controller.signal, ...capableRecallConsumerDeclaration() });
  controller.abort(reason);
  await expect(page.acknowledge_delivery!(page.index, new Map())).rejects.toBe(reason);
  await expect(page.discard_delivery!()).resolves.toBeUndefined();
});
