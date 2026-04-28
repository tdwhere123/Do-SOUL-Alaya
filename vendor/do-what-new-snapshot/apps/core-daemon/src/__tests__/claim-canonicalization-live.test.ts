import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreDaemonServices } from "../app.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceKind, type EventLogEntry } from "@do-what/protocol";

const bootstrappedDaemon = vi.hoisted(() => ({
  app: null as null | {
    request(input: string, init?: RequestInit): Promise<Response>;
  },
  services: null as null | CoreDaemonServices,
  serverClose: vi.fn(),
  backgroundStart: vi.fn(),
  backgroundStop: vi.fn(async () => undefined)
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(() => ({
    close: bootstrappedDaemon.serverClose
  }))
}));

vi.mock("../background/bootstrap.js", () => ({
  BackgroundServiceManager: vi.fn().mockImplementation(function BackgroundServiceManager() {
    return {
      start: bootstrappedDaemon.backgroundStart,
      stop: bootstrappedDaemon.backgroundStop
    };
  })
}));

vi.mock("../app.js", async () => {
  const actual = await vi.importActual<typeof import("../app.js")>("../app.js");

  return {
    ...actual,
    createApp: vi.fn((services: CoreDaemonServices) => {
      const app = actual.createApp(services);
      bootstrappedDaemon.app = app;
      bootstrappedDaemon.services = services;
      return app;
    })
  };
});

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.();
  }

  vi.resetModules();
  vi.clearAllMocks();
  bootstrappedDaemon.app = null;
  bootstrappedDaemon.services = null;
});

describe("live daemon claim canonicalization", () => {
  it(
    "uses the real daemon alias-map wiring for multilingual claim writes",
    async () => {
      const { app, services } = await bootstrapDaemon();
      const workspace = await createWorkspace(app, "claim-canonicalization-live");

      const created = await services.claimService.create({
        created_by: "user_action",
        governance_subject_domain: "用户偏好",
        governance_subject_qualifiers: {
          framework: "类型脚本"
        },
        claim_kind: "constraint",
        scope_class: "project",
        enforcement_level: "strict",
        origin_tier: "user_explicit",
        precedence_basis: "authority",
        proposition_digest: "Use pnpm for workspace commands.",
        evidence_refs: [],
        source_object_refs: [],
        workspace_id: workspace.workspace_id
      });

      expect(created.governance_subject.canonical_key).toBe("user_preference::framework=typescript");

      const eventLogRepo = services.eventLogRepo as {
        queryByType(eventType: string): Promise<readonly EventLogEntry[]>;
      };
      const appliedEvents = await eventLogRepo.queryByType("canonicalization.applied");
      const aliasResolvedEvents = await eventLogRepo.queryByType("canonicalization.alias_resolved");

      expect(appliedEvents).toHaveLength(2);
      expect(aliasResolvedEvents).toHaveLength(2);
      expect(aliasResolvedEvents[0]?.payload_json).toMatchObject({
        alias: "用户偏好",
        canonical: "user_preference",
        domain: "governance_subject.domain",
        language: "zh"
      });
      expect(aliasResolvedEvents[1]?.payload_json).toMatchObject({
        alias: "类型脚本",
        canonical: "typescript",
        domain: "governance_subject.qualifier.framework",
        language: "zh"
      });
    },
    10_000
  );
});

async function bootstrapDaemon(): Promise<{
  readonly app: NonNullable<typeof bootstrappedDaemon.app>;
  readonly services: NonNullable<typeof bootstrappedDaemon.services>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "do-what-c1-daemon-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousOrphanDetection = process.env.ORPHAN_DETECTION_ENABLED;
  cleanups.push(() => {
    process.env.DATA_DIR = previousDataDir;
    process.env.ORPHAN_DETECTION_ENABLED = previousOrphanDetection;
    rmSync(dataDir, { recursive: true, force: true });
  });

  process.env.DATA_DIR = dataDir;
  process.env.ORPHAN_DETECTION_ENABLED = "false";

  await import("../index.js");

  if (bootstrappedDaemon.app === null || bootstrappedDaemon.services === null) {
    throw new Error("daemon bootstrap did not capture the real app services");
  }

  return {
    app: bootstrappedDaemon.app,
    services: bootstrappedDaemon.services
  };
}

async function createWorkspace(
  app: NonNullable<typeof bootstrappedDaemon.app>,
  name: string
): Promise<{ readonly workspace_id: string }> {
  const requestToken = await getRequestToken(app);
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-do-what-desktop": "1",
      "x-request-token": requestToken
    },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { workspace_id: string } };
  return body.data;
}

async function getRequestToken(app: NonNullable<typeof bootstrappedDaemon.app>): Promise<string> {
  const response = await app.request("/session/request-token", {
    headers: {
      "x-do-what-desktop": "1"
    }
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: {
      request_token: string;
    };
  };
  return body.data.request_token;
}
