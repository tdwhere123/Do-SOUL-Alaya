import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashCommandService } from "../slash-command-service.js";
import type { ClaudeSDKClientFactory } from "../runtime-adapters/claude-sdk-client.js";

describe("SlashCommandService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sanitizes SDK dispatch failures before returning public command results", async () => {
    const service = new SlashCommandService({
      clientFactory: {
        listSupportedSlashCommands: vi.fn(async () => [
          {
            name: "cost",
            description: "Show cost",
            argumentHint: ""
          }
        ]),
        dispatchSlashCommand: vi.fn(async () => {
          throw new Error("secret provider path /tmp/do-what-token");
        })
      },
      runRepo: {
        getById: vi.fn(async () => ({
          run_id: "run-1",
          workspace_id: "workspace-1",
          engine_class: "coding_engine"
        }) as any)
      },
      workspaceRepo: {
        getById: vi.fn(async () => ({
          workspace_id: "workspace-1",
          root_path: "/workspace/project",
          default_engine_class: "coding_engine"
        }) as any)
      },
      warn: vi.fn()
    });

    await expect(
      service.dispatchCommand({
        name: "/cost",
        runId: "run-1"
      })
    ).resolves.toEqual({
      name: "/cost",
      status: "failed",
      message: "Slash command dispatch failed."
    });
  });

  it("dedupes in-flight slash discovery and keeps a short per-run cache", async () => {
    const discovery = createDeferred<readonly [{ readonly name: "cost"; readonly description: "Show cost"; readonly argumentHint: "" }]>();
    const listSupportedSlashCommands = vi.fn(() => discovery.promise);
    const service = createService({
      listSupportedSlashCommands,
      discoveryCacheTtlMs: 100
    });

    const first = service.listCommands({ runId: "run-1" });
    const second = service.listCommands({ runId: "run-1" });

    await vi.waitFor(() => expect(listSupportedSlashCommands).toHaveBeenCalledTimes(1));
    discovery.resolve([
      {
        name: "cost",
        description: "Show cost",
        argumentHint: ""
      }
    ]);

    await expect(first).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: true,
          dispatchable: true
        })
      ])
    });
    await expect(second).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: true,
          dispatchable: true
        })
      ])
    });

    await expect(service.listCommands({ runId: "run-1" })).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: true,
          dispatchable: true
        })
      ])
    });
    expect(listSupportedSlashCommands).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 125));
    await expect(service.listCommands({ runId: "run-1" })).resolves.toBeDefined();
    expect(listSupportedSlashCommands).toHaveBeenCalledTimes(2);
  });

  it("bounds slash discovery latency and returns unavailable descriptors on timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const listSupportedSlashCommands = vi.fn(() => new Promise<never>(() => {}));
    const service = createService({
      listSupportedSlashCommands,
      discoveryTimeoutMs: 10,
      warn
    });

    const result = service.listCommands({ runId: "run-1" });
    const expectation = expect(result).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: false,
          dispatchable: false,
          unavailable_reason: "Claude SDK slash command discovery failed for this run."
        })
      ])
    });
    await vi.advanceTimersByTimeAsync(10);

    await expectation;
    expect(warn).toHaveBeenCalledWith(
      "[SlashCommandService] slash command discovery failed",
      expect.objectContaining({
        run_id: "run-1"
      })
    );
  });

  it("does not invoke SDK discovery or dispatch for conversation_engine runs", async () => {
    const listSupportedSlashCommands = vi.fn(async () => [
      {
        name: "cost",
        description: "Show cost",
        argumentHint: ""
      }
    ]);
    const dispatchSlashCommand = vi.fn(async () => "ok");
    const service = createService({
      listSupportedSlashCommands,
      dispatchSlashCommand,
      runEngineClass: "conversation_engine",
      workspaceDefaultEngineClass: "conversation_engine"
    });

    await expect(service.listCommands({ runId: "run-1" })).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: false,
          dispatchable: false,
          unavailable_reason: "Slash commands require a coding_engine principal run."
        })
      ])
    });
    await expect(service.dispatchCommand({ name: "/cost", runId: "run-1" })).resolves.toEqual({
      name: "/cost",
      status: "unavailable",
      message: "Slash command /cost is unavailable: Slash commands require a coding_engine principal run."
    });
    expect(listSupportedSlashCommands).not.toHaveBeenCalled();
    expect(dispatchSlashCommand).not.toHaveBeenCalled();
  });

  it("does not invoke SDK discovery when principal coding runtime is unavailable", async () => {
    const listSupportedSlashCommands = vi.fn(async () => [
      {
        name: "cost",
        description: "Show cost",
        argumentHint: ""
      }
    ]);
    const service = createService({
      listSupportedSlashCommands,
      isPrincipalCodingEngineAvailable: () => false
    });

    await expect(service.listCommands({ runId: "run-1" })).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: "/cost",
          available: false,
          dispatchable: false,
          unavailable_reason: "coding_engine is not available for principal runs on this backend."
        })
      ])
    });
    expect(listSupportedSlashCommands).not.toHaveBeenCalled();
  });
});

function createService(options: {
  readonly listSupportedSlashCommands?: NonNullable<ClaudeSDKClientFactory["listSupportedSlashCommands"]>;
  readonly dispatchSlashCommand?: NonNullable<ClaudeSDKClientFactory["dispatchSlashCommand"]>;
  readonly discoveryTimeoutMs?: number;
  readonly discoveryCacheTtlMs?: number;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly runEngineClass?: "coding_engine" | "conversation_engine" | null;
  readonly workspaceDefaultEngineClass?: "coding_engine" | "conversation_engine" | null;
  readonly isPrincipalCodingEngineAvailable?: () => boolean;
} = {}): SlashCommandService {
  return new SlashCommandService({
    clientFactory: {
      listSupportedSlashCommands: options.listSupportedSlashCommands ?? vi.fn(async () => []),
      dispatchSlashCommand: options.dispatchSlashCommand ?? vi.fn(async () => "ok")
    },
    runRepo: {
      getById: vi.fn(async () => ({
        run_id: "run-1",
        workspace_id: "workspace-1",
        engine_class: options.runEngineClass ?? "coding_engine"
      }) as any)
    },
    workspaceRepo: {
      getById: vi.fn(async () => ({
        workspace_id: "workspace-1",
        root_path: "/workspace/project",
        default_engine_class: options.workspaceDefaultEngineClass ?? "coding_engine"
      }) as any)
    },
    isPrincipalCodingEngineAvailable: options.isPrincipalCodingEngineAvailable ?? (() => true),
    warn: options.warn ?? vi.fn(),
    discoveryTimeoutMs: options.discoveryTimeoutMs,
    discoveryCacheTtlMs: options.discoveryCacheTtlMs
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
