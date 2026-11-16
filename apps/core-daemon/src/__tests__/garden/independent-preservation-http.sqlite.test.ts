import { once } from "node:events";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { EventPublisher, WorkspaceService } from "@do-soul/alaya-core";
import { SqliteRunRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { registerSynthesisRoutes } from "../../routes/memory/entries/syntheses.js";
import { createPreservationFixture, PRESERVATION_WORKSPACE as WS } from "./independent-preservation.test-support.js";

it("serves explicitly historical material over HTTP with workspace containment and irreversible erase", async () => {
  const f = await createPreservationFixture();
  const workspaceRepo = new SqliteWorkspaceRepo(f.database);
  await workspaceRepo.create({ workspace_id: "independent-workspace", name: "Independent", root_path: "/tmp/independent",
    workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
  const workspaceService = new WorkspaceService({ workspaceRepo, runRepo: new SqliteRunRepo(f.database),
    eventPublisher: new EventPublisher({ eventLogRepo: f.eventLogRepo, runHotStateService: { apply: () => undefined },
      runtimeNotifier: { ...f.notifier, notify: () => undefined } }) });
  const app = new Hono();
  registerSynthesisRoutes(app, { workspaceService, synthesisService: f.synthesisService });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected an HTTP port");
    const base = `http://127.0.0.1:${address.port}`;
    const published = await f.publishMember("http-source");
    const sibling = await f.publishMember("http-independent-sibling", "Independent sibling material only.");
    const capsule = await f.createCapsule([published.memory.object_id, sibling.memory.object_id]);
    const path = (ws: string) => `${base}/workspaces/${ws}/syntheses/${capsule.object_id}/historical-members/${published.memory.object_id}`;
    await f.sweep(); await f.sweep(true);
    expect(await f.memoryService.findById(published.memory.object_id)).toBeNull();
    expect(await f.memoryService.findById(sibling.memory.object_id)).toBeNull();
    const siblingPath = `${base}/workspaces/${WS}/syntheses/${capsule.object_id}/historical-members/${sibling.memory.object_id}`;
    const siblingBefore = await (await fetch(siblingPath)).json();
    expect(siblingBefore).toMatchObject({ data: { status: "ready", history: { member: { content: sibling.memory.content } } } });
    expect(JSON.stringify(siblingBefore)).not.toContain(published.memory.content);
    expect(JSON.stringify(siblingBefore)).not.toContain(capsule.summary);
    const response = await fetch(path(WS));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: "ready", history: {
      kind: "historical_memory_capture", member: { content: published.memory.content, lifecycle_state: "dormant" }
    } } });
    expect(await (await fetch(path("independent-workspace"))).json()).toEqual({ success: true, data: { status: "missing" } });
    f.field.fieldRepos.erase.apply({ barrier_id: "http-erase", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: published.source.record.identity, erased_at: "2020-01-03T00:00:00.000Z" });
    expect(await (await fetch(path(WS))).json()).toEqual({ success: true, data: { status: "erased" } });
    expect(await (await fetch(siblingPath)).json()).toEqual(siblingBefore);
    const live = await (await fetch(`${base}/workspaces/${WS}/syntheses/${capsule.object_id}`)).json();
    expect(live).toMatchObject({ data: { summary: "erased", topic_key: "erased", lifecycle_state: "tombstone" } });
    expect(JSON.stringify(live)).not.toContain(published.memory.content);
    const reopened = f.reopen();
    expect(await reopened.synthesisService.readHistoricalMember(WS, capsule.object_id, sibling.memory.object_id))
      .toMatchObject({ status: "ready", history: { member: { content: sibling.memory.content } } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.dispose();
  }
});
