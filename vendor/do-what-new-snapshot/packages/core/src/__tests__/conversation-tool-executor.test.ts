import type {
  ConversationRuntimeContext,
  EventLogEntry,
  ToolExecutionRecord,
  ToolGovernanceDecision,
  ToolSpec
} from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { CanonicalAliasService } from "../canonical-alias-service.js";
import { ToolGovernanceClient } from "../ports/tool-governance-client.js";
import { ToolSubstrate } from "../tool-substrate/index.js";
import { ConversationToolExecutor } from "../tool-hot-path/conversation-tool-executor.js";
import { ToolFastPath } from "../tool-hot-path/fast-path.js";

type TestExtensionProvider = {
  provider_id: string;
  name: string;
  source: "builtin" | "mcp_external" | "skill_package" | "user_configured";
  tool_specs: readonly {
    tool_id: string;
    name: string;
    description: string;
  }[];
  requires_permission_check: boolean;
  records_execution: boolean;
  registered_at: string;
};

describe("ConversationToolExecutor", () => {
  it("governs and records assistant-originated tool calls as principal actions", async () => {
    const harness = createHarness();

    const result = await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async (context) => {
        expect(context.sessionConfig.role).toBe("principal");
        expect(context.sessionConfig.tool_profile).toBe("default");
        return { ok: true };
      }
    });

    expect(result.executionRecord.requested_by).toBe("principal");
    expect(harness.governanceQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_by: "principal"
      })
    );
    const startedEntry = harness.appendedEntries.find((entry) => entry.event_type === "tool_call.started");
    expect(startedEntry?.payload_json).toMatchObject({
      toolId: "tools.write_file"
    });
    expect((startedEntry?.payload_json as { workerId?: string } | undefined)?.workerId).toBeUndefined();
  });

  it("records governance deny outcomes with workspace context before returning denied", async () => {
    const harness = createHarness({
      governanceDecision: {
        final_result: "deny",
        matched_claim_refs: [],
        matched_slot_refs: [],
        hard_constraints_present: true,
        requires_red_card: true,
        explanation_summary: "denied"
      }
    });
    const handler = vi.fn(async () => ({ ok: true }));

    const result = await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler
    });

    expect(result.permissionResult).toBe("deny");
    expect(handler).not.toHaveBeenCalled();
    expect(harness.recordOutcome).toHaveBeenCalledWith(
      "run-1",
      "workspace-1",
      "msg-assistant-1",
      "tooling.policy::scope=project,tool=tools.write_file",
      "deny"
    );
  });

  it("passes node-scoped governance context and strict breaker posture into hot-path decisions", async () => {
    const harness = createHarness({
      toolSpec: createToolSpec({ destructive: true }),
      circuitBreakerState: {
        postureLevel: 2,
        additionalDeniedCategories: [],
        cooldownUntil: "2026-04-12T11:00:00.000Z"
      }
    });
    const handler = vi.fn(async () => ({ ok: true }));

    const result = await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler
    });

    expect(result.permissionResult).toBe("deny");
    expect(handler).not.toHaveBeenCalled();
    expect(harness.governanceClientQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_by: "principal"
      }),
      "msg-assistant-1"
    );
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual(["tool.intent.denied"]);
  });

  it("collects nested path-like fields into governance target_paths", async () => {
    const harness = createHarness();

    await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: {
        targets: [{ targetPath: "src/index.ts" }, { directory: "docs" }],
        options: { cwd: "." },
        baseDir: "packages"
      },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({ ok: true })
    });

    expect(harness.governanceClientQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        target_paths: ["src/index.ts", "docs", ".", "packages"]
      }),
      "msg-assistant-1"
    );
  });

  it("keeps guarded breaker posture below strict so destructive tools can still execute", async () => {
    const harness = createHarness({
      toolSpec: createToolSpec({ destructive: true }),
      circuitBreakerState: {
        postureLevel: 1,
        additionalDeniedCategories: [],
        cooldownUntil: "2026-04-12T11:00:00.000Z"
      }
    });
    const handler = vi.fn(async () => ({ ok: true }));

    const result = await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler
    });

    expect(result.permissionResult).toBe("allow");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("publishes canonicalization events before the live governance query", async () => {
    const publishedCanonicalizationEvents: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const publish = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
      publishedCanonicalizationEvents.push(entry);
      return {
        ...entry,
        event_id: `canon-${publishedCanonicalizationEvents.length}`,
        created_at: "2026-04-12T10:00:00.050Z"
      } satisfies EventLogEntry;
    });
    const harness = createHarness({
      canonicalAliasService: new CanonicalAliasService({
        aliasMap: {},
        eventPublisher: {
          publish
        }
      } as any)
    });

    await harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({ ok: true })
    });

    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      harness.governanceClientQuery.mock.invocationCallOrder[0]
    );
    expect(publishedCanonicalizationEvents.map((entry) => entry.event_type)).toEqual([
      "canonicalization.applied",
      "canonicalization.applied",
      "canonicalization.applied"
    ]);
    expect(publishedCanonicalizationEvents[0]?.payload_json).toMatchObject({
      input: "tooling.policy",
      canonical: "tooling.policy",
      domain: "governance_subject.domain",
      was_alias_resolved: false
    });
  });

  it("loads the tool spec and extension provider in parallel before executing the hot path", async () => {
    let resolveToolSpec: ((value: ToolSpec) => void) | undefined;
    let resolveProvider:
      | ((value: TestExtensionProvider | null) => void)
      | undefined;
    const toolSpecFindById = vi.fn(
      () =>
        new Promise<ToolSpec>((resolve) => {
          resolveToolSpec = resolve;
        })
    );
    const providerLookup = vi.fn(
      () =>
        new Promise<{
          provider_id: string;
          name: string;
          source: "builtin" | "mcp_external" | "skill_package" | "user_configured";
          tool_specs: readonly {
            tool_id: string;
            name: string;
            description: string;
          }[];
          requires_permission_check: boolean;
          records_execution: boolean;
          registered_at: string;
        } | null>((resolve) => {
          resolveProvider = resolve;
        })
    );
    const harness = createHarness({
      toolSpecFindById,
      providerLookup
    });

    const executionPromise = harness.executor.execute({
      toolId: "tools.write_file",
      rawInput: { path: "notes.txt" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({ ok: true })
    });

    await Promise.resolve();

    expect(toolSpecFindById).toHaveBeenCalledWith("tools.write_file");
    expect(providerLookup).toHaveBeenCalledWith("tools.write_file");

    resolveToolSpec?.(createToolSpec());
    resolveProvider?.(null);

    await expect(executionPromise).resolves.toMatchObject({
      permissionResult: "allow"
    });
  });

  it("emits extension.governance_checked for external providers after governance execution", async () => {
    const harness = createHarness({
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await harness.executor.execute({
      toolId: "mcp__filesystem__read_file",
      rawInput: { path: "README.md" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async (context) => {
        expect(context.sessionConfig.allowed_mcp_servers).toEqual(["filesystem"]);
        return { ok: true };
      }
    });

    const governanceCheckedEntry = harness.appendedEntries.find(
      (entry) => entry.event_type === "extension.governance_checked"
    );

    expect(governanceCheckedEntry).toBeDefined();
    expect(governanceCheckedEntry?.entity_type).toBe("extension_provider");
    expect(governanceCheckedEntry?.entity_id).toBe("provider.mcp.filesystem");
    expect(governanceCheckedEntry?.payload_json).toMatchObject({
      tool_id: "mcp__filesystem__read_file",
      provider_id: "provider.mcp.filesystem",
      permission_checked: true,
      execution_recorded: true
    });
  });

  it("emits extension.governance_checked for each external tool execution", async () => {
    const harness = createHarness({
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await harness.executor.execute({
      toolId: "mcp__filesystem__read_file",
      rawInput: { path: "README.md" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({ ok: true })
    });

    await harness.executor.execute({
      toolId: "mcp__filesystem__read_file",
      rawInput: { path: "README.md" },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({ ok: true })
    });

    expect(
      harness.appendedEntries.filter((entry) => entry.event_type === "extension.governance_checked")
    ).toHaveLength(2);
  });

  it("does not emit extension.governance_checked when the governance query fails", async () => {
    const harness = createHarness({
      governanceQueryImpl: async () => {
        throw new Error("governance query failed");
      },
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await expect(
      harness.executor.execute({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        workspaceRoot: "/workspace/project",
        handler: async () => ({ ok: true })
      })
    ).rejects.toThrow("governance query failed");

    expect(
      harness.appendedEntries.filter((entry) => entry.event_type === "extension.governance_checked")
    ).toHaveLength(0);
  });

  it("emits extension.governance_checked after external tool failures once the execution record is persisted", async () => {
    const harness = createHarness({
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await expect(
      harness.executor.execute({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        workspaceRoot: "/workspace/project",
        handler: async () => {
          throw new Error("tool failed");
        }
      })
    ).rejects.toThrow("tool failed");

    expect(
      harness.appendedEntries.filter((entry) => entry.event_type === "extension.governance_checked")
    ).toHaveLength(1);
  });

  it("does not emit extension.governance_checked when execution-record persistence fails", async () => {
    const harness = createHarness({
      executionRecordInsert: async () => {
        throw new Error("execution record insert failed");
      },
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await expect(
      harness.executor.execute({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        workspaceRoot: "/workspace/project",
        handler: async () => ({ ok: true })
      })
    ).rejects.toThrow("execution record insert failed");

    expect(
      harness.appendedEntries.filter((entry) => entry.event_type === "extension.governance_checked")
    ).toHaveLength(0);
  });

  it("keeps successful external tool executions successful when extension.governance_checked append fails", async () => {
    const warn = vi.fn();
    const harness = createHarness({
      warn,
      eventLogAppend: async (entry) => {
        if (entry.event_type === "extension.governance_checked") {
          throw new Error("audit append failed");
        }

        return {
          ...entry,
          event_id: "event-pre-audit",
          created_at: "2026-04-12T10:00:00.100Z"
        } satisfies EventLogEntry;
      },
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await expect(
      harness.executor.execute({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        workspaceRoot: "/workspace/project",
        handler: async () => ({ ok: true })
      })
    ).resolves.toMatchObject({
      permissionResult: "allow"
    });

    expect(warn).toHaveBeenCalledWith("failed to emit extension.governance_checked", {
      providerId: "provider.mcp.filesystem",
      toolId: "mcp__filesystem__read_file",
      error: expect.objectContaining({
        message: "audit append failed"
      })
    });
  });

  it("preserves the original external tool failure when extension.governance_checked append also fails", async () => {
    const warn = vi.fn();
    const harness = createHarness({
      warn,
      eventLogAppend: async (entry) => {
        if (entry.event_type === "extension.governance_checked") {
          throw new Error("audit append failed");
        }

        return {
          ...entry,
          event_id: "event-pre-audit",
          created_at: "2026-04-12T10:00:00.100Z"
        } satisfies EventLogEntry;
      },
      extensionProvider: {
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: "2026-04-20T10:45:00.000Z"
      },
      toolSpec: createToolSpec({
        tool_id: "mcp__filesystem__read_file",
        description: "Read file through filesystem MCP.",
        category: "exec",
        read_only: false,
        fast_path_eligible: false
      })
    });

    await expect(
      harness.executor.execute({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        runtimeContext: createRuntimeContext(),
        workspaceRoot: "/workspace/project",
        handler: async () => {
          throw new Error("tool failed");
        }
      })
    ).rejects.toThrow("tool failed");

    expect(warn).toHaveBeenCalledWith("failed to emit extension.governance_checked", {
      providerId: "provider.mcp.filesystem",
      toolId: "mcp__filesystem__read_file",
      error: expect.objectContaining({
        message: "audit append failed"
      })
    });
  });
});

function createHarness(options: {
  readonly governanceDecision?: {
    final_result: "allow" | "ask" | "deny";
    matched_claim_refs: readonly string[];
    matched_slot_refs: readonly string[];
    hard_constraints_present: boolean;
    requires_red_card: boolean;
    explanation_summary: string;
  };
  readonly toolSpec?: ToolSpec;
  readonly circuitBreakerState?: {
    postureLevel: 0 | 1 | 2;
    additionalDeniedCategories: readonly ToolSpec["category"][];
    cooldownUntil: string | null;
  };
  readonly canonicalAliasService?: CanonicalAliasService;
  readonly extensionProvider?: TestExtensionProvider;
  readonly governanceQueryImpl?: () => Promise<Readonly<ToolGovernanceDecision>>;
  readonly executionRecordInsert?: (
    record: ToolExecutionRecord
  ) => Promise<Readonly<ToolExecutionRecord>>;
  readonly toolSpecFindById?: (toolId: string) => Promise<Readonly<ToolSpec>>;
  readonly providerLookup?: (toolId: string) => Promise<Readonly<TestExtensionProvider> | null>;
  readonly eventLogAppend?: (
    entry: Omit<EventLogEntry, "event_id" | "created_at">
  ) => Promise<EventLogEntry>;
  readonly sseBroadcastEntry?: (entry: EventLogEntry) => Promise<void>;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
} = {}) {
  const appendedEntries: EventLogEntry[] = [];
  const governanceQuery = vi.fn(
    options.governanceQueryImpl ??
      (async () =>
        options.governanceDecision ?? {
          final_result: "allow" as const,
          matched_claim_refs: [],
          matched_slot_refs: [],
          hard_constraints_present: false,
          requires_red_card: false,
          explanation_summary: "ok"
        })
  );
  const recordOutcome = vi.fn(async () => undefined);
  const executionRecordInsert =
    options.executionRecordInsert ?? (async (record: ToolExecutionRecord) => record);
  const governanceClient = new ToolGovernanceClient({
    port: {
      kind: "test-governance",
      queryToolGovernance: governanceQuery
    }
  });
  const governanceClientQuery = vi.spyOn(governanceClient, "query");
  const substrate = new ToolSubstrate({
    generateExecutionId: () => "exec-001",
    now: () => "2026-04-12T10:00:00.000Z"
  });
  const toolSpecFindById = vi.fn(
    options.toolSpecFindById ?? (async () => options.toolSpec ?? createToolSpec())
  );
  const providerLookup = vi.fn(
    options.providerLookup ?? (async () => options.extensionProvider ?? null)
  );
  const eventLogAppend = vi.fn(
    options.eventLogAppend ??
      (async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const appended = {
          ...entry,
          event_id: `event-${appendedEntries.length + 1}`,
          created_at: "2026-04-12T10:00:00.100Z"
        } satisfies EventLogEntry;
        appendedEntries.push(appended);
        return appended;
      })
  );
  const sseBroadcastEntry = vi.fn(options.sseBroadcastEntry ?? (async () => undefined));

  const executor = new ConversationToolExecutor({
    toolSpecService: {
      findById: toolSpecFindById
    },
    substrate,
    governanceClient,
    fastPath: new ToolFastPath({
      substrate,
      executionRecordRepo: {
        insert: vi.fn(async (record: ToolExecutionRecord) => record)
      },
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
          ...entry,
          event_id: "fast-event-1",
          created_at: "2026-04-12T10:00:00.000Z"
        }))
      },
      sseBroadcaster: {
        broadcastEntry: vi.fn(async () => undefined)
      }
    }),
    targetRevalidateService: {
      findAndRevalidate: vi.fn(async () => [])
    },
    executionRecordRepo: {
      insert: vi.fn(executionRecordInsert)
    },
    eventLogRepo: {
      append: eventLogAppend
    },
    sseBroadcaster: {
      broadcastEntry: sseBroadcastEntry
    },
    circuitBreaker: {
      getState: vi.fn(() => ({
        postureLevel: options.circuitBreakerState?.postureLevel ?? (0 as const),
        additionalDeniedCategories: options.circuitBreakerState?.additionalDeniedCategories ?? [],
        cooldownUntil: options.circuitBreakerState?.cooldownUntil ?? null
      })),
      recordOutcome
    },
    extensionRegistry: {
      findProviderForTool: providerLookup
    },
    canonicalAliasService: options.canonicalAliasService,
    warn: options.warn,
    now: () => "2026-04-12T10:00:01.000Z",
    generateExecutionId: () => "gov-001"
  });

  return {
    executor,
    appendedEntries,
    governanceQuery,
    governanceClientQuery,
    recordOutcome,
    toolSpecFindById,
    providerLookup,
    warn: options.warn
  };
}

function createRuntimeContext(): ConversationRuntimeContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    user_message_id: "msg-user-1",
    assistant_message_id: "msg-assistant-1"
  };
}

function createToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: overrides.tool_id ?? "tools.write_file",
    category: overrides.category ?? "write",
    description: overrides.description ?? "Write a file in the workspace.",
    scope_guard: overrides.scope_guard ?? "project",
    read_only: overrides.read_only ?? false,
    destructive: overrides.destructive ?? false,
    concurrency_safe: overrides.concurrency_safe ?? true,
    interrupt_behavior: overrides.interrupt_behavior ?? "continue",
    requires_confirmation: overrides.requires_confirmation ?? false,
    requires_evidence_reopen: overrides.requires_evidence_reopen ?? false,
    rollback_support: overrides.rollback_support ?? "none",
    fast_path_eligible: overrides.fast_path_eligible ?? false
  };
}
