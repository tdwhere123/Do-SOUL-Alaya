import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EventPublisher,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  EvidenceHealthState,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
import { createKnowledgeFoundation } from
  "../../../runtime/daemon/wiring/daemon-knowledge-foundation.js";
import { createDaemonRepositories } from
  "../../../runtime/daemon/wiring/daemon-repositories.js";

describe("daemon knowledge foundation", () => {
  it("forms Fact Keys for verified user assertions without a model proposal", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const runtimeNotifier: RuntimeNotifier = {
        notify: vi.fn(),
        notifyEntry: vi.fn()
      };
      const warn = vi.fn();
      const repositories = createDaemonRepositories({ database, warn });
      await seedWorkspaceRun(repositories);
      const eventPublisher = new EventPublisher({
        eventLogRepo: repositories.eventLogRepo,
        runHotStateService: { apply: vi.fn() },
        runtimeNotifier
      });
      const foundation = createKnowledgeFoundation({
        ...repositories,
        database,
        filesDirectory: "/tmp/alaya-daemon-knowledge-foundation-test",
        runtimeNotifier,
        configPaths: {
          configDir: "/tmp/alaya-daemon-knowledge-foundation-test",
          tomlPath: "/tmp/alaya-daemon-knowledge-foundation-test/config.toml",
          envPath: "/tmp/alaya-daemon-knowledge-foundation-test/.env",
          auditDir: "/tmp/alaya-daemon-knowledge-foundation-test/audit",
          secretsDir: "/tmp/alaya-daemon-knowledge-foundation-test/secrets",
          operationsDir: "/tmp/alaya-daemon-knowledge-foundation-test/operations"
        },
        warnLogger: {
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
          fatal: vi.fn()
        }
      }, eventPublisher);

      const assertion = "I have a dog.";
      const evidence = await foundation.evidenceService.create({
        created_by: "garden_compile",
        evidence_kind: "conversation_excerpt",
        semantic_anchor: {
          topic: "user assertion",
          keywords: ["dog"],
          summary: assertion
        },
        event_anchor: null,
        physical_anchor: {
          file_path: null,
          line_range: null,
          symbol_name: null,
          artifact_ref: null
        },
        evidence_health_state: EvidenceHealthState.VERIFIED,
        gist: assertion,
        excerpt: assertion,
        source_hash: verifiedAssertionSourceHash(assertion),
        run_id: "run-1",
        workspace_id: "workspace-1",
        surface_id: null
      });

      const qualified = await repositories.evidenceCapsuleRepo
        .findRecallQualifiedFactKeysByIds("workspace-1", [evidence.object_id]);

      expect(qualified.map((row) => row.matched_projection?.content))
        .toContain("I have a dog");
      expect(qualified[0]?.matched_fact_frame?.slots).toEqual([
        { role: "subject", text: "I" },
        { role: "relation", text: "have" },
        { role: "value", text: "a dog" }
      ]);
    } finally {
      database.close();
    }
  });
});

function verifiedAssertionSourceHash(assertion: string): string {
  const preimage = buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source_assertion: assertion,
    source_corpus: assertion
  });
  return formatVerifiedUserAssertionSourceHash(
    createHash("sha256").update(preimage, "utf8").digest("hex")
  );
}

async function seedWorkspaceRun(
  repositories: ReturnType<typeof createDaemonRepositories>
): Promise<void> {
  await repositories.workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await repositories.runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run-1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}
