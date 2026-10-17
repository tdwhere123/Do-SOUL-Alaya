import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const previous = process.env.NODE_OPTIONS;
  const bootstrap = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${bootstrap}`.trim();
  return { ...installProviderFreeBoundary(), previous };
});
afterAll(() => {
  isolation.restore();
  if (isolation.previous === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = isolation.previous;
});
afterEach(() => { vi.unstubAllEnvs(); expect(isolation.violations).toEqual([]); });

import { FieldGenerationEventType, type SourceAdmissionRequest } from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../../index.js";

// This boots real daemon wiring, including its built worker boundary. Run after
// the coordinator's integrated build; no local substitutes or provider bindings.
it("exposes predecessor-bound replacement through the wired Node capability and retains prior records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daemon-source-replacement-"));
  // The shared guard permits only this native fixture configuration namespace.
  const config = join(tmpdir(), `alaya-bench-config-${randomUUID()}`);
  mkdirSync(config);
  const dataDir = join(directory, "data"), workspaceRoot = join(directory, "workspace");
  mkdirSync(workspaceRoot);
  for (const [key, value] of Object.entries({ DATA_DIR: dataDir, ALAYA_CONFIG_DIR: config,
    HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex-home"),
    ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx", ALAYA_SQLITE_WRITE_QUEUE: "0" })) {
    vi.stubEnv(key, value);
  }
  let runtime: AlayaDaemonRuntime | undefined;
  try {
    runtime = await createAlayaDaemonRuntime();
    await expect(runtime.services.embeddingProviderWarmup).resolves.toBe("not_requested");
    await runtime.services.workspaceService.ensureLocalWorkspace({ workspaceId: "workspace-replacement", name: "Source replacement", rootPath: workspaceRoot });
    const request: SourceAdmissionRequest = { workspace_id: "workspace-replacement", source_id: "message", source_version: "1",
      content_bytes: "Initial source.", evidence_object_id: null, recorded_at: "2026-09-13T00:00:00.000Z",
      event_time: "2026-01-01T00:00:00Z", valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
      source_representation: { kind: "original_body" }, spans: [] };
    const context = { workspaceId: request.workspace_id };
    const predecessor = await runtime.services.sourceRecordAdmission.admit(request, context);
    expect(typeof runtime.services.sourceRecordReplacement.replaceCurrent).toBe("function");
    const replacement = { ...request, source_version: "2", content_bytes: "Revised source.", recorded_at: "2026-09-13T00:00:01.000Z" };
    const result = await runtime.services.sourceRecordReplacement.replaceCurrent({ expected_current: predecessor.record, replacement }, context);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("wired capability did not complete");
    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    expect(database.connection.prepare("SELECT source_version, source_body, event_time FROM source_records WHERE workspace_id = ? ORDER BY source_version")
      .all(request.workspace_id)).toEqual([
      { source_version: "1", source_body: "Initial source.", event_time: "2026-01-01T00:00:00Z" },
      { source_version: "2", source_body: "Revised source.", event_time: "2026-01-01T00:00:00Z" }
    ]);
    expect(result.transition.predecessor).toEqual(predecessor.record);
    expect(database.connection.prepare("SELECT entity_id FROM event_log WHERE workspace_id = ? AND event_type = ? ORDER BY entity_id")
      .all(request.workspace_id, FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED)).toEqual(
      [predecessor.record.identity, result.transition.replacement.record.identity].sort().map(entity_id => ({ entity_id })));
    expect((await runtime.services.sourceRecordReplacement.replaceCurrent({ expected_current: predecessor.record, replacement }, context)).status).toBe("rejected");
    expect((await runtime.services.sourceRecordReplacement.replaceCurrent({ expected_current: result.transition.replacement.record,
      replacement: { ...replacement, source_version: "3", recorded_at: "2026-09-13T00:00:02.000Z" } }, { workspaceId: "foreign" })).status).toBe("rejected");
    expect(database.connection.prepare("SELECT count(*) AS n FROM source_records WHERE workspace_id = ?").get(request.workspace_id)).toEqual({ n: 2 });
  } finally {
    try { await runtime?.shutdown(); }
    finally { rmSync(directory, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true }); }
  }
}, 45_000);

it("exposes deferred predecessor-bound replacement through the wired Node capability until checkpoint publishes the new frontier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "daemon-source-replacement-deferred-"));
  const config = join(tmpdir(), `alaya-bench-config-${randomUUID()}`);
  mkdirSync(config);
  const dataDir = join(directory, "data"), workspaceRoot = join(directory, "workspace");
  mkdirSync(workspaceRoot);
  for (const [key, value] of Object.entries({ DATA_DIR: dataDir, ALAYA_CONFIG_DIR: config,
    HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex-home"),
    ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false", ALAYA_EMBEDDING_PROVIDER: "local_onnx", ALAYA_SQLITE_WRITE_QUEUE: "0" })) {
    vi.stubEnv(key, value);
  }
  let runtime: AlayaDaemonRuntime | undefined;
  try {
    runtime = await createAlayaDaemonRuntime({ fieldProjectionAdmissionMode: "explicit_checkpoint" });
    await expect(runtime.services.embeddingProviderWarmup).resolves.toBe("not_requested");
    await runtime.services.workspaceService.ensureLocalWorkspace({ workspaceId: "workspace-replacement", name: "Source replacement", rootPath: workspaceRoot });
    const request: SourceAdmissionRequest = { workspace_id: "workspace-replacement", source_id: "message", source_version: "1",
      content_bytes: "Initial source.", evidence_object_id: null, recorded_at: "2026-09-13T00:00:00.000Z",
      event_time: "2026-01-01T00:00:00Z", valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
      source_representation: { kind: "original_body" }, spans: [] };
    const context = { workspaceId: request.workspace_id };
    const predecessor = await runtime.services.sourceRecordAdmission.admit(request, context);
    await runtime.services.fieldProjectionCheckpoint.refresh();
    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    const publishedFrontier = database.connection.prepare(
      "SELECT g.generation_id, g.input_event_frontier FROM projection_generation_pointer p JOIN projection_generations g ON g.workspace_id = p.workspace_id AND g.generation_id = p.active_generation_id WHERE p.workspace_id = ?");
    const oldFrontier = publishedFrontier.get(request.workspace_id);
    if (oldFrontier === undefined) throw new Error("published predecessor frontier required");
    const notified: Array<{ event_type: string; entity_id: string }> = [];
    const subscription = runtime.runtimeNotifier.subscribeWorkspace(request.workspace_id, entry => {
      notified.push({ event_type: entry.event_type, entity_id: entry.entity_id });
    });
    try {
      const replacement = { ...request, source_version: "2", content_bytes: "Revised source.", recorded_at: "2026-09-13T00:00:01.000Z" };
      const result = await runtime.services.sourceRecordReplacement.replaceCurrent({ expected_current: predecessor.record, replacement }, context);
      expect(result.status).toBe("committed_projection_deferred");
      if (result.status !== "committed_projection_deferred") throw new Error("wired capability did not defer projection");
      expect(result.transition.predecessor).toEqual(predecessor.record);
      expect(result.transition.replacement.record.source_version).toBe("2");
      expect(database.connection.prepare("SELECT source_version, source_body FROM source_records WHERE workspace_id = ? ORDER BY source_version")
        .all(request.workspace_id)).toEqual([
        { source_version: "1", source_body: "Initial source." },
        { source_version: "2", source_body: "Revised source." }
      ]);
      expect(publishedFrontier.get(request.workspace_id)).toEqual(oldFrontier);
      expect(database.connection.prepare("SELECT workspace_id FROM field_projection_rebuild_requests").all())
        .toEqual([{ workspace_id: request.workspace_id }]);
      expect(notified).toEqual([{ event_type: FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED,
        entity_id: result.transition.replacement.record.identity }]);
      await runtime.services.fieldProjectionCheckpoint.refresh();
      const replacementFrontier = publishedFrontier.get(request.workspace_id);
      expect(replacementFrontier).not.toEqual(oldFrontier);
      if (replacementFrontier === undefined) throw new Error("published replacement frontier required");
      expect(database.connection.prepare("SELECT workspace_id FROM field_projection_rebuild_requests").all()).toEqual([]);
    } finally {
      subscription.dispose();
    }
  } finally {
    try { await runtime?.shutdown(); }
    finally { rmSync(directory, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true }); }
  }
}, 45_000);
