import * as os from "node:os";
import {
  RuntimeSessionConfigSchema,
  SlashCommandDescriptorSchema,
  SlashCommandDispatchResultSchema,
  SlashCommandListResultSchema,
  type Run,
  type RuntimeSessionConfig,
  type SlashCommandDescriptor,
  type SlashCommandDispatchResult,
  type SlashCommandListResult,
  type Workspace
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import type {
  ClaudeSDKClientFactory,
  ClaudeSDKSlashCommand
} from "./runtime-adapters/claude-sdk-client.js";
import {
  gatherLocalDiscoveries,
  type DiscoveredCommandSource,
  type DiscoveredSlashCommand
} from "./slash-local-skill-discovery.js";

export interface SlashCommandRunRepoPort {
  getById(id: string): Promise<Run | null>;
}

export interface SlashCommandWorkspaceRepoPort {
  getById(id: string): Promise<Workspace | null>;
}

export interface SlashCommandServiceDependencies {
  readonly clientFactory: Pick<
    ClaudeSDKClientFactory,
    "listSupportedSlashCommands" | "dispatchSlashCommand"
  >;
  readonly runRepo: SlashCommandRunRepoPort;
  readonly workspaceRepo: SlashCommandWorkspaceRepoPort;
  readonly resolveAllowedMcpServers?: (input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly role: "principal";
  }) => Promise<readonly string[]> | readonly string[];
  readonly isPrincipalCodingEngineAvailable?: () => boolean;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly discoveryTimeoutMs?: number;
  readonly discoveryCacheTtlMs?: number;
}

export interface ListSlashCommandsInput {
  readonly runId?: string;
}

export interface DispatchSlashCommandInput {
  readonly name: string;
  readonly runId: string;
}

const ALLOWLISTED_NON_INTERACTIVE_COMMANDS = new Map([
  // Governance boundary: each entry must be intentionally allowlisted,
  // SDK-dispatchable, and non-interactive before do-what exposes it.
  [
    "/cost",
    {
      description: "Show Claude Code session cost"
    }
  ]
]);

const KNOWN_UNAVAILABLE_COMMANDS = new Map([
  [
    "/help",
    {
      description: "Show Claude Code interactive help",
      reason: "Interactive Claude CLI command; not allowlisted for non-interactive do-what dispatch."
    }
  ],
  [
    "/model",
    {
      description: "Change the active Claude model",
      reason: "Interactive Claude CLI command; model changes are owned by workspace engine settings."
    }
  ],
  [
    "/permissions",
    {
      description: "Open Claude Code permission controls",
      reason: "Interactive Claude CLI command; permissions are owned by do-what runtime policy."
    }
  ]
]);

const DEFAULT_SLASH_DISCOVERY_TIMEOUT_MS = 2_000;
const DEFAULT_SLASH_DISCOVERY_CACHE_TTL_MS = 1_000;

interface SlashDiscoveryResult {
  readonly supportedByName: ReadonlyMap<string, ClaudeSDKSlashCommand>;
  readonly failed: boolean;
  readonly unavailableReason: string | null;
}

interface SlashDiscoveryCacheEntry {
  readonly promise: Promise<SlashDiscoveryResult>;
  expiresAtEpochMs: number;
  settled: boolean;
}

export class SlashCommandService {
  private readonly discoveryByRunId = new Map<string, SlashDiscoveryCacheEntry>();

  public constructor(private readonly dependencies: SlashCommandServiceDependencies) {}

  public async listCommands(input: ListSlashCommandsInput = {}): Promise<SlashCommandListResult> {
    const discovery = await this.discoverSupportedCommands(input.runId);
    const names = new Set<string>([
      ...ALLOWLISTED_NON_INTERACTIVE_COMMANDS.keys(),
      ...KNOWN_UNAVAILABLE_COMMANDS.keys(),
      ...discovery.supportedByName.keys()
    ]);

    return SlashCommandListResultSchema.parse({
      commands: [...names].sort().map((name) =>
        this.buildDescriptor(name, {
          hasRunContext: input.runId !== undefined,
          supported: discovery.supportedByName.get(name) ?? null,
          discoveryFailed: discovery.failed,
          unavailableReason: discovery.unavailableReason
        })
      )
    });
  }

  public async dispatchCommand(input: DispatchSlashCommandInput): Promise<SlashCommandDispatchResult> {
    const name = normalizeSlashCommandName(input.name);
    const allowlisted = ALLOWLISTED_NON_INTERACTIVE_COMMANDS.get(name);
    if (allowlisted === undefined) {
      return this.unavailableResult(
        name,
        KNOWN_UNAVAILABLE_COMMANDS.get(name)?.reason ??
          "Slash command is not allowlisted for non-interactive do-what dispatch."
      );
    }

    if (this.dependencies.clientFactory.dispatchSlashCommand === undefined) {
      return this.unavailableResult(name, "Claude SDK slash dispatch is not wired.");
    }

    const sessionConfig = await this.resolvePrincipalCodingSessionConfig(input.runId);
    if (sessionConfig.status === "unavailable") {
      return this.unavailableResult(name, sessionConfig.reason);
    }

    const discovery = await this.discoverSupportedCommands(input.runId, sessionConfig.config);
    if (!discovery.supportedByName.has(name)) {
      return this.unavailableResult(
        name,
        discovery.failed
          ? "Claude SDK slash command discovery failed for this run."
          : "Claude SDK did not report this command for this run."
      );
    }

    try {
      const message = await this.dependencies.clientFactory.dispatchSlashCommand({
        sessionConfig: sessionConfig.config,
        command: name
      });
      return SlashCommandDispatchResultSchema.parse({
        name,
        status: "dispatched",
        message
      });
    } catch (error) {
      this.dependencies.warn("[SlashCommandService] slash command dispatch failed", {
        run_id: input.runId,
        command: name,
        error
      });
      return SlashCommandDispatchResultSchema.parse({
        name,
        status: "failed",
        message: "Slash command dispatch failed."
      });
    }
  }

  /**
   * Discovers all local Claude Code skill/command entries from the filesystem
   * and merges them with the SDK's listSupportedSlashCommands result.
   *
   * Returns ALL records including available=false ones. Caller is responsible
   * for palette filtering. Does not require a runId.
   */
  public async discoverLocalSkillCommands(
    homeDir?: string
  ): Promise<DiscoveredSlashCommand[]> {
    const resolvedHomeDir = homeDir ?? os.homedir();

    // Gather local filesystem discoveries (user commands, skills, plugins).
    const local = await gatherLocalDiscoveries(resolvedHomeDir, this.dependencies.warn);

    // Gather SDK discoveries if the factory supports it (no runId context needed
    // for the index; we skip session-config resolution here).
    let sdkCommands: DiscoveredSlashCommand[] = [];
    if (this.dependencies.clientFactory.listSupportedSlashCommands !== undefined) {
      try {
        // Use a minimal session config stub — discovery index does not dispatch,
        // so we just need the raw list. If the factory requires sessionConfig,
        // pass an empty-ish object that won't be validated here.
        const supported = await this.dependencies.clientFactory.listSupportedSlashCommands({
          sessionConfig: {} as RuntimeSessionConfig
        });
        sdkCommands = supported.map((cmd): DiscoveredSlashCommand => {
          const canonicalName = normalizeSlashCommandName(cmd.name);
          const knownUnavailable = KNOWN_UNAVAILABLE_COMMANDS.get(canonicalName);
          return {
            source: "sdk" as DiscoveredCommandSource,
            origin: "sdk",
            name: canonicalName,
            display_name: undefined,
            description: cmd.description,
            available: knownUnavailable === undefined,
            ...(knownUnavailable !== undefined
              ? { unavailable_reason: knownUnavailable.reason }
              : {}),
            filter_keywords: [],
            source_path: ""
          };
        });
      } catch (err) {
        this.dependencies.warn("[SlashCommandService] SDK discovery failed in discoverLocalSkillCommands", {
          error: err
        });
      }
    }

    // Merge: build a map keyed by canonical /name; local entries take precedence
    // over SDK entries so that local source/metadata is authoritative.
    const index = new Map<string, DiscoveredSlashCommand>();

    // Insert SDK entries first (lower priority).
    for (const cmd of sdkCommands) {
      index.set(cmd.name, cmd);
    }

    // Insert local entries, overwriting any SDK entry with the same name.
    // If a local entry's name is in KNOWN_UNAVAILABLE_COMMANDS, apply the
    // unavailable annotation so the record is still correct.
    for (const cmd of local) {
      const knownUnavailable = KNOWN_UNAVAILABLE_COMMANDS.get(cmd.name);
      if (knownUnavailable !== undefined) {
        index.set(cmd.name, {
          ...cmd,
          available: false,
          unavailable_reason: knownUnavailable.reason
        });
      } else {
        index.set(cmd.name, cmd);
      }
    }

    return [...index.values()];
  }

  private async discoverSupportedCommands(
    runId: string | undefined,
    knownSessionConfig?: RuntimeSessionConfig
  ): Promise<SlashDiscoveryResult> {
    if (runId === undefined || this.dependencies.clientFactory.listSupportedSlashCommands === undefined) {
      return {
        supportedByName: new Map(),
        failed: false,
        unavailableReason: null
      };
    }

    const now = Date.now();
    this.pruneExpiredDiscoveryCache(now);
    const cached = this.discoveryByRunId.get(runId);
    if (cached !== undefined && (!cached.settled || cached.expiresAtEpochMs > now)) {
      return cached.promise;
    }

    const promise = this.performSupportedCommandDiscovery(runId, knownSessionConfig);
    const entry: SlashDiscoveryCacheEntry = {
      promise,
      expiresAtEpochMs: Number.POSITIVE_INFINITY,
      settled: false
    };
    this.discoveryByRunId.set(runId, entry);
    void promise.finally(() => {
      entry.settled = true;
      entry.expiresAtEpochMs = Date.now() + (this.dependencies.discoveryCacheTtlMs ?? DEFAULT_SLASH_DISCOVERY_CACHE_TTL_MS);
    });

    return promise;
  }

  private pruneExpiredDiscoveryCache(now: number): void {
    for (const [runId, entry] of this.discoveryByRunId) {
      if (entry.settled && entry.expiresAtEpochMs <= now) {
        this.discoveryByRunId.delete(runId);
      }
    }
  }

  private async performSupportedCommandDiscovery(
    runId: string,
    knownSessionConfig?: RuntimeSessionConfig
  ): Promise<SlashDiscoveryResult> {
    try {
      const sessionConfigResult = knownSessionConfig === undefined
        ? await this.resolvePrincipalCodingSessionConfig(runId)
        : { status: "available" as const, config: knownSessionConfig };
      if (sessionConfigResult.status === "unavailable") {
        return {
          supportedByName: new Map(),
          failed: false,
          unavailableReason: sessionConfigResult.reason
        };
      }

      const listPromise = this.dependencies.clientFactory.listSupportedSlashCommands!({
        sessionConfig: sessionConfigResult.config
      });
      listPromise.catch(() => undefined);
      const supported = await withTimeout(
        listPromise,
        this.dependencies.discoveryTimeoutMs ?? DEFAULT_SLASH_DISCOVERY_TIMEOUT_MS,
        "Claude SDK slash command discovery timed out."
      );
      return {
        supportedByName: new Map(
          supported.map((command) => [normalizeSlashCommandName(command.name), command])
        ),
        failed: false,
        unavailableReason: null
      };
    } catch (error) {
      this.dependencies.warn("[SlashCommandService] slash command discovery failed", {
        run_id: runId,
        error
      });
      return {
        supportedByName: new Map(),
        failed: true,
        unavailableReason: null
      };
    }
  }

  private buildDescriptor(
    name: string,
    input: {
      readonly hasRunContext: boolean;
      readonly supported: ClaudeSDKSlashCommand | null;
      readonly discoveryFailed: boolean;
      readonly unavailableReason: string | null;
    }
  ): SlashCommandDescriptor {
    const allowlisted = ALLOWLISTED_NON_INTERACTIVE_COMMANDS.get(name);
    const knownUnavailable = KNOWN_UNAVAILABLE_COMMANDS.get(name);

    if (allowlisted !== undefined) {
      const available = input.supported !== null;
      return SlashCommandDescriptorSchema.parse({
        name,
        description: input.supported?.description ?? allowlisted.description,
        available,
        dispatchable: available,
        ...(!available
          ? {
              unavailable_reason: input.hasRunContext
                ? input.unavailableReason ??
                  (input.discoveryFailed
                  ? "Claude SDK slash command discovery failed for this run."
                  : "Claude SDK did not report this command for this run.")
                : "Run context is required before SDK slash command discovery."
            }
          : {})
      });
    }

    return SlashCommandDescriptorSchema.parse({
      name,
      description: input.supported?.description ?? knownUnavailable?.description ?? "Unsupported slash command",
      available: input.supported !== null,
      dispatchable: false,
      unavailable_reason:
        knownUnavailable?.reason ??
        "Supported by SDK but not allowlisted for non-interactive do-what dispatch."
    });
  }

  private async resolvePrincipalCodingSessionConfig(runId: string): Promise<
    | { readonly status: "available"; readonly config: RuntimeSessionConfig }
    | { readonly status: "unavailable"; readonly reason: string }
  > {
    const run = await this.dependencies.runRepo.getById(runId);
    if (run === null) {
      throw new CoreError("NOT_FOUND", `Unknown run: ${runId}`);
    }

    const workspace = await this.dependencies.workspaceRepo.getById(run.workspace_id);
    if (workspace === null) {
      throw new CoreError("NOT_FOUND", `Unknown workspace: ${run.workspace_id}`);
    }

    const engineClass = run.engine_class ?? workspace.default_engine_class ?? "conversation_engine";
    if (engineClass !== "coding_engine") {
      return {
        status: "unavailable",
        reason: "Slash commands require a coding_engine principal run."
      };
    }

    if (
      this.dependencies.isPrincipalCodingEngineAvailable !== undefined &&
      !this.dependencies.isPrincipalCodingEngineAvailable()
    ) {
      return {
        status: "unavailable",
        reason: "coding_engine is not available for principal runs on this backend."
      };
    }

    const allowedMcpServers = await this.dependencies.resolveAllowedMcpServers?.({
      workspaceId: workspace.workspace_id,
      runId: run.run_id,
      role: "principal"
    }) ?? [];

    return {
      status: "available",
      config: RuntimeSessionConfigSchema.parse({
        role: "principal",
        workspace_id: workspace.workspace_id,
        run_id: run.run_id,
        cwd: workspace.root_path,
        writable_roots: [workspace.root_path],
        tool_profile: "principal_coding",
        allowed_mcp_servers: [...allowedMcpServers],
        sandbox_policy: "workspace_write",
        permission_policy: "default",
        network_policy: "restricted"
      })
    };
  }

  private unavailableResult(name: string, reason: string): SlashCommandDispatchResult {
    return SlashCommandDispatchResultSchema.parse({
      name,
      status: "unavailable",
      message: `Slash command ${name} is unavailable: ${reason}`
    });
  }
}

function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}
