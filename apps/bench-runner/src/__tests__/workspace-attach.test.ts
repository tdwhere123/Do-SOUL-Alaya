import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { MemorySearchResult } from "@do-soul/alaya-protocol";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../harness/daemon.js";

// @anchor bench-workspace-attach-contract: per-question workspace isolation
// + daemon-per-run lifecycle. see also: apps/bench-runner/src/harness/daemon.ts
//   attachWorkspace, BenchWorkspaceHandle

const handles: BenchDaemonHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.shutdown().catch(() => undefined);
  }
});

describe("BenchDaemon attachWorkspace contract", () => {
  it(
    "single daemon serves multiple attached workspaces without restart",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "attach-default-ws",
        runId: "attach-default-run"
      });
      handles.push(daemon);

      const runtimeBefore = daemon.runtime;
      const dataDirBefore = daemon.dataDir;

      const workspaces: { workspaceId: string; runId: string; memoryId: string }[] = [];
      for (const idx of [1, 2, 3]) {
        const workspace = await daemon.attachWorkspace({
          workspaceId: `attach-ws-${idx}`,
          runId: `attach-run-${idx}`
        });
        const seed = await workspace.proposeMemory(
          `Workspace ${idx} memory body — independent of any other workspace.`,
          `attach-evidence-${idx}`
        );
        workspaces.push({
          workspaceId: workspace.workspaceId,
          runId: workspace.runId,
          memoryId: seed.memoryId
        });
        await workspace.detach();
      }

      // invariant: the underlying daemon resources are stable across
      // workspace attach/detach cycles — the same runtime / dataDir served
      // every question.
      expect(daemon.runtime).toBe(runtimeBefore);
      expect(daemon.dataDir).toBe(dataDirBefore);
      expect(workspaces).toHaveLength(3);
      for (const ws of workspaces) {
        expect(typeof ws.memoryId).toBe("string");
        expect(ws.memoryId.length).toBeGreaterThan(0);
      }
    },
    120_000
  );

  it(
    "isolates memories across attached workspaces (A writes do not appear in B recall)",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "isolation-default-ws",
        runId: "isolation-default-run"
      });
      handles.push(daemon);

      const workspaceA = await daemon.attachWorkspace({
        workspaceId: "isolation-ws-A",
        runId: "isolation-run-A"
      });
      const seedA = await workspaceA.proposeMemory(
        "Salient fact owned by workspace A — coelacanth swims at depth.",
        "isolation-evidence-A"
      );
      const recallA = await workspaceA.recall("coelacanth swims at depth", {
        maxResults: 10
      });
      expect(recallA.results.map((r: MemorySearchResult) => r.object_id)).toContain(seedA.memoryId);
      await workspaceA.detach();

      const workspaceB = await daemon.attachWorkspace({
        workspaceId: "isolation-ws-B",
        runId: "isolation-run-B"
      });
      const recallB = await workspaceB.recall("coelacanth swims at depth", {
        maxResults: 10
      });
      // invariant: workspace_id is the recall isolation boundary; a memory
      // seeded in workspace A must never surface in workspace B's recall.
      // see also: packages/core/src/recall-service.ts (workspaceId filter)
      expect(recallB.results.map((r: MemorySearchResult) => r.object_id)).not.toContain(
        seedA.memoryId
      );
      await workspaceB.detach();
    },
    120_000
  );

  it(
    "active workspace tracks the most recent attach (proposeMemory binds correct workspace_id)",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "active-ctx-default-ws",
        runId: "active-ctx-default-run"
      });
      handles.push(daemon);

      const workspaceA = await daemon.attachWorkspace({
        workspaceId: "active-ctx-A",
        runId: "active-ctx-run-A"
      });
      expect(daemon.workspaceId).toBe("active-ctx-A");
      expect(daemon.runId).toBe("active-ctx-run-A");
      const seedA = await workspaceA.proposeMemory(
        "Active context probe for workspace A.",
        "active-ctx-evidence-A"
      );
      await workspaceA.detach();

      const workspaceB = await daemon.attachWorkspace({
        workspaceId: "active-ctx-B",
        runId: "active-ctx-run-B"
      });
      expect(daemon.workspaceId).toBe("active-ctx-B");
      expect(daemon.runId).toBe("active-ctx-run-B");

      // workspaceA.recall after re-attaching B still queries workspace A's
      // recall service path (workspace_id is bound by the workspace handle's
      // closures via activeContext snapshot at attach time on the daemon
      // side; recall reads activeContext at call time, so we re-attach to
      // verify the seeded memory persists and can be recalled).
      await workspaceB.detach();

      const workspaceAAgain = await daemon.attachWorkspace({
        workspaceId: "active-ctx-A",
        runId: "active-ctx-run-A-second"
      });
      const recall = await workspaceAAgain.recall(
        "Active context probe workspace A",
        { maxResults: 5 }
      );
      expect(recall.results.map((r: MemorySearchResult) => r.object_id)).toContain(seedA.memoryId);
      await workspaceAAgain.detach();
    },
    120_000
  );

  it(
    "shutdown closes the underlying runtime so dataDir-bound resources are released",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "shutdown-ws",
        runId: "shutdown-run"
      });
      const dataDir = daemon.dataDir;
      const before = await stat(dataDir);
      expect(before.isDirectory()).toBe(true);

      await daemon.shutdown();
      // invariant: shutdown releases the active-daemon slot so a second
      // startBenchDaemon may proceed in the same process. The dataDir
      // remains on disk (mkdtemp is non-destructive on shutdown for archive
      // inspection); rm is the runner-script's responsibility.
      const after = await stat(dataDir);
      expect(after.isDirectory()).toBe(true);

      const daemon2 = await startBenchDaemon({
        workspaceId: "shutdown-second-ws",
        runId: "shutdown-second-run"
      });
      handles.push(daemon2);
      expect(daemon2.dataDir).not.toBe(dataDir);
    },
    120_000
  );
});
