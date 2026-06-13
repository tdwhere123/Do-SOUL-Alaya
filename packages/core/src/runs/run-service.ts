import { randomUUID } from "node:crypto";
import {
  EngineBindingRecordSchema,
  WorkspaceRunEventType,
  RunMode,
  RunRenameInputSchema,
  RunSchema,
  RunState,
  RunCreatedPayloadSchema,
  RunDeletedPayloadSchema,
  RunRenamedPayloadSchema,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisher } from "../runtime/event-publisher.js";

export interface RunRepoPort {
  create(data: {
    readonly run_id: string;
    readonly workspace_id: string;
    readonly title: Run["title"];
    readonly goal: Run["goal"];
    readonly run_mode: Run["run_mode"];
    readonly engine_binding_id: Run["engine_binding_id"];
    readonly engine_class: Run["engine_class"];
    readonly run_state: Run["run_state"];
    readonly current_surface_id: Run["current_surface_id"];
  }): Run;
  getById(id: string): Promise<Run | null>;
  listByWorkspace(workspaceId: string): Promise<readonly Run[]>;
  delete(id: string): void;
  update(id: string, patch: Partial<Run>): Run;
}

export interface RunWorkspaceRepoPort {
  getById(id: string): Promise<Workspace | null>;
}

export interface RunEngineBindingRepoPort {
  getById(id: string): Promise<unknown>;
}

const CreateRunInputSchema = RunSchema.unwrap()
  .pick({
    title: true,
    goal: true,
    run_mode: true,
    engine_binding_id: true,
    engine_class: true
  })
  .partial({
    title: true,
    goal: true,
    run_mode: true,
    engine_binding_id: true,
    engine_class: true
  });

export type CreateRunInput = {
  readonly title?: Run["title"];
  readonly goal?: Run["goal"];
  readonly run_mode?: Run["run_mode"];
  readonly engine_binding_id?: Run["engine_binding_id"];
  readonly engine_class?: Run["engine_class"];
};

export interface EnsureAttachedMcpSessionRunInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly agentTarget: string;
}

export interface RunServiceDependencies {
  readonly workspaceRepo: RunWorkspaceRepoPort;
  readonly runRepo: RunRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly isPrincipalCodingEngineAvailable?: () => boolean;
  readonly bindingRepo?: RunEngineBindingRepoPort;
}

export class RunService {
  public constructor(private readonly dependencies: RunServiceDependencies) {}

  public async create(workspaceId: string, input: unknown): Promise<Run> {
    const workspace = await this.requireWorkspace(workspaceId);
    const parsed = parseCreateRunInput(input);
    const runId = `run_${randomUUID()}`;
    const runTitle = resolveRunTitle(parsed.title);
    const runMode = parsed.run_mode ?? RunMode.CHAT;
    const engineClass = parsed.engine_class ?? workspace.default_engine_class ?? null;
    let persistedBindingId = parsed.engine_binding_id ?? null;

    if (engineClass === null) {
      throw new CoreError("CONFLICT", "Run principal engine is not configured for this workspace");
    }

    if (engineClass === "coding_engine") {
      if (
        this.dependencies.isPrincipalCodingEngineAvailable === undefined ||
        !this.dependencies.isPrincipalCodingEngineAvailable()
      ) {
        throw new CoreError(
          "CONFLICT",
          "coding_engine is not available for principal runs on this backend"
        );
      }
    }

    if (engineClass === "conversation_engine") {
      persistedBindingId = await this.resolveWorkspaceOwnedConversationBinding(parsed.engine_binding_id, workspace);
    }

    return this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.RUN_CREATED,
          entity_type: "run",
          entity_id: runId,
          workspace_id: workspace.workspace_id,
          run_id: runId,
          caused_by: "user_action",
          payload_json: RunCreatedPayloadSchema.parse({
            run_id: runId,
            workspace_id: workspace.workspace_id,
            run_mode: runMode,
            title: runTitle
          })
        }
      ],
      () =>
        this.dependencies.runRepo.create({
          run_id: runId,
          workspace_id: workspace.workspace_id,
          title: runTitle,
          goal: parsed.goal ?? null,
          run_mode: runMode,
          engine_binding_id: persistedBindingId,
          engine_class: engineClass,
          run_state: RunState.IDLE,
          current_surface_id: null
        })
    );
  }

  public async ensureAttachedMcpSessionRun(input: EnsureAttachedMcpSessionRunInput): Promise<Run> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    const existing = await this.dependencies.runRepo.getById(input.sessionId);
    if (existing !== null) {
      if (existing.workspace_id !== workspace.workspace_id) {
        throw new CoreError("CONFLICT", "MCP session run belongs to a different workspace");
      }
      return existing;
    }

    const title = `MCP session ${input.agentTarget}`;
    return this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.RUN_CREATED,
          entity_type: "run",
          entity_id: input.sessionId,
          workspace_id: workspace.workspace_id,
          run_id: input.sessionId,
          caused_by: input.agentTarget,
          payload_json: RunCreatedPayloadSchema.parse({
            run_id: input.sessionId,
            workspace_id: workspace.workspace_id,
            run_mode: RunMode.CHAT,
            title
          })
        }
      ],
      () =>
        this.dependencies.runRepo.create({
          run_id: input.sessionId,
          workspace_id: workspace.workspace_id,
          title,
          goal: "Attached MCP session",
          run_mode: RunMode.CHAT,
          engine_binding_id: null,
          engine_class: null,
          run_state: RunState.ACTIVE,
          current_surface_id: null
        })
    );
  }

  public async listByWorkspace(workspaceId: string): Promise<readonly Run[]> {
    await this.requireWorkspace(workspaceId);
    return this.dependencies.runRepo.listByWorkspace(workspaceId);
  }

  public async getById(runId: string): Promise<Run> {
    const run = await this.dependencies.runRepo.getById(runId);

    if (run === null) {
      throw new CoreError("NOT_FOUND", "Run not found");
    }

    return run;
  }

  public async rename(input: unknown): Promise<Run> {
    const parsed = parseRenameInput(input);
    const run = await this.dependencies.runRepo.getById(parsed.run_id);

    if (run === null) {
      throw new CoreError("NOT_FOUND", "Run not found");
    }

    return this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.RUN_RENAMED,
          entity_type: "run",
          entity_id: run.run_id,
          workspace_id: run.workspace_id,
          run_id: run.run_id,
          caused_by: "user_action",
          payload_json: RunRenamedPayloadSchema.parse({
            run_id: run.run_id,
            title: parsed.title,
            previous_title: run.title
          })
        }
      ],
      () => this.dependencies.runRepo.update(run.run_id, { title: parsed.title })
    );
  }

  public async delete(runId: string): Promise<Run> {
    const run = await this.getById(runId);

    await this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.RUN_DELETED,
          entity_type: "run",
          entity_id: run.run_id,
          workspace_id: run.workspace_id,
          run_id: run.run_id,
          caused_by: "user_action",
          payload_json: RunDeletedPayloadSchema.parse({
            run_id: run.run_id,
            workspace_id: run.workspace_id
          })
        }
      ],
      () => this.dependencies.runRepo.delete(run.run_id)
    );

    return run;
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);

    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    return workspace;
  }

  private async resolveWorkspaceOwnedConversationBinding(
    runBindingId: string | null | undefined,
    workspace: Workspace
  ): Promise<string> {
    const bindingId = runBindingId ?? workspace.default_engine_binding;

    if (bindingId === null) {
      throw new CoreError(
        "CONFLICT",
        "conversation_engine requires an existing workspace engine binding"
      );
    }

    if (this.dependencies.bindingRepo === undefined) {
      throw new CoreError(
        "CONFLICT",
        "conversation_engine cannot be resolved because engine binding lookup is unavailable"
      );
    }

    const bindingCandidate = await this.dependencies.bindingRepo.getById(bindingId);

    if (bindingCandidate === null) {
      throw new CoreError("CONFLICT", "Configured conversation engine binding could not be found");
    }

    let bindingWorkspaceId: string;
    try {
      bindingWorkspaceId = EngineBindingRecordSchema.parse(bindingCandidate).workspace_id;
    } catch {
      throw new CoreError("CONFLICT", "Configured conversation engine binding could not be found");
    }

    if (bindingWorkspaceId !== workspace.workspace_id) {
      throw new CoreError(
        "CONFLICT",
        "Configured conversation engine binding does not belong to this workspace"
      );
    }

    return bindingId;
  }
}

function parseRenameInput(input: unknown): { readonly run_id: string; readonly title: string } {
  try {
    return RunRenameInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function parseCreateRunInput(input: unknown): CreateRunInput {
  try {
    return CreateRunInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function resolveRunTitle(title: string | undefined): string {
  const normalizedTitle = title?.trim();

  if (normalizedTitle !== undefined && normalizedTitle.length > 0) {
    return normalizedTitle;
  }

  const now = new Date();

  return `Run ${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())} ${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}
