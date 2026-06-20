import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { afterEach, describe, expect, it } from "vitest";

import {
  FormationKind,
  HealthEventKind,
  MemoryDimension,
  GardenEventType,
  ProposalResolutionState,
  RunMode,
  RunState,
  ScopeClass,
  SignalState,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type Proposal,
  type SoulEmitCandidateSignalResponse,
  type SoulMemorySearchResponse,
  type SoulOpenPointerResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulReviewMemoryProposalResponse,
  type TrustSummary
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteHealthJournalRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";

import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory/tool-catalog.js";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { registerAlayaCliCommands } from "../../cli/register.js";

import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

import { createAlayaMcpServer } from "../../mcp/mcp-server.js";

import {
  PRIMARY_MEMORY_ID,
  FOREIGN_MEMORY_ID,
  FOREIGN_PROPOSAL_ID,
  tempDirs,
  originalDataDir,
  originalOpenAiApiKey,
  originalAlayaOpenAiSecretRef,
  originalEmbeddingSupplementOptIn,
  originalAlayaConfigDir,
  originalCodexHome,
  originalHome,
  originalReviewerIdentity,
  originalReviewerToken,
  RELEASE_LOOP_TIMEOUT_MS,
  callTool,
  dispatchCli,
  seedReleaseFixture,
  seedReleaseFixtureAtDbPath,
  readMemoryEntry,
  readReleaseEvidence,
  readGardenEvidence,
  readOperationBundle,
  createMemoryEntry,
  createProposal,
  createTempDataDir,
  restoreProcessEnv
} from "./release-loop-fixture.js";

describe("P5 v0.1 release loop E2E", () => {

  it("uses installed config storage when DATA_DIR differs", async () => {
    const dataDir = await createTempDataDir();
    const configDir = join(dataDir, "config");
    const configuredDbPath = join(dataDir, "configured-storage", "alaya.db");
    const misleadingDataDir = join(dataDir, "misleading-data-dir");
    process.env.DATA_DIR = misleadingDataDir;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    process.env.ALAYA_CONFIG_DIR = configDir;
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "alaya.toml"),
      `[storage]\ndb_path = "${configuredDbPath}"\n`,
      "utf8"
    );
    await seedReleaseFixtureAtDbPath(configuredDbPath);

    const runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();
    const server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        sessionId: "p5-config-storage-session",
        surfaceId: "p5-config-storage"
      })
    });
    const client = new Client(
      { name: "p5-config-storage", version: "test" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const recall = await callTool<SoulMemorySearchResponse>(client, "soul.recall", {
        query: "pnpm workspace commands",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PREFERENCE,
        domain_tags: null,
        max_results: 3
      });
      expect(recall.results.map((result) => result.object_id)).toEqual([
        "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      ]);

      await runtime.runGardenBackgroundPass();

      const status = await dispatchCli(runtime, ["status", "--agent", "codex", "--json"]);
      expect(status.exitCode).toBe(0);
      expect(status.json).toMatchObject({
        daemon: { up: true },
        garden: { last_pass_at: expect.any(String) }
      });

      const doctor = await dispatchCli(runtime, ["doctor", "--workspace", "workspace-1", "--json"]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.json).toMatchObject({
        garden: { status: "healthy", last_pass_at: expect.any(String) },
        storage: {
          db_path: configuredDbPath,
          exists: true,
          writable: true
        }
      });

      const backupPath = join(dataDir, "configured-backup.json");
      const backup = await dispatchCli(runtime, ["backup", "--output", backupPath, "--json"]);
      const backupBundle = await readOperationBundle(backupPath);
      expect(backup.exitCode).toBe(0);
      expect(backupBundle.storage.db_path).toBe(configuredDbPath);
      expect(backupBundle.storage.db_base64.length).toBeGreaterThan(0);

      const exportPath = join(dataDir, "configured-export.json");
      const exportResult = await dispatchCli(runtime, ["export", "--output", exportPath, "--json"]);
      const exportBundle = await readOperationBundle(exportPath);
      expect(exportResult.exitCode).toBe(0);
      expect(exportBundle.storage.db_path).toBe(configuredDbPath);
      expect(exportBundle.storage.db_base64.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  }, RELEASE_LOOP_TIMEOUT_MS);
});
