import { randomUUID } from "node:crypto";
import {
  EngineBindingInputSchema,
  EngineError,
  EngineErrorKind,
  WorkspaceRunEventType,
  WorkspaceEngineBindingUpdatedPayloadSchema,
  type EngineBinding,
  type EngineBindingInput,
  type EngineBindingRecord,
  type EngineBindingTestPort,
  type EngineConnectionTestResult,
  type Run,
  type Workspace
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisher } from "../runtime/event-publisher.js";

export interface EngineBindingWorkspaceRepoPort {
  getById(id: string): Promise<Workspace | null>;
  updateDefaultEngineBinding(id: string, bindingId: string | null): Workspace;
}

export interface EngineBindingRepoPort {
  upsert(data: Omit<EngineBindingRecord, "created_at" | "updated_at">): EngineBindingRecord;
  getById(id: string): Promise<EngineBindingRecord | null>;
}

export interface EngineBindingServiceDependencies {
  readonly workspaceRepo: EngineBindingWorkspaceRepoPort;
  readonly bindingRepo: EngineBindingRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly engineTester: EngineBindingTestPort;
}

export class EngineBindingService {
  public constructor(private readonly dependencies: EngineBindingServiceDependencies) {}

  public async getWorkspaceBinding(workspaceId: string): Promise<EngineBindingRecord | null> {
    const workspace = await this.requireWorkspace(workspaceId);

    if (workspace.default_engine_binding === null) {
      return null;
    }

    return await this.requireWorkspaceOwnedBinding(
      workspace.default_engine_binding,
      workspace.workspace_id,
      () => new CoreError("NOT_FOUND", "Engine binding not found"),
      () => new CoreError("CONFLICT", "Engine binding does not belong to this workspace")
    );
  }

  public async saveWorkspaceBinding(workspaceId: string, input: unknown): Promise<EngineBindingRecord> {
    const workspace = await this.requireWorkspace(workspaceId);
    const parsed = parseEngineBindingInput(input);
    const bindingId = `binding_${randomUUID()}`;

    return this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED,
          entity_type: "workspace",
          entity_id: workspace.workspace_id,
          workspace_id: workspace.workspace_id,
          run_id: null,
          caused_by: "user_action",
          payload_json: WorkspaceEngineBindingUpdatedPayloadSchema.parse({
            workspace_id: workspace.workspace_id,
            binding_id: bindingId,
            provider_type: parsed.provider_type,
            model: parsed.model,
            base_url: parsed.base_url
          })
        }
      ],
      () => {
        // Both writes are sync better-sqlite3 ops; the publish/upsert/binding
        // update happens inside a single transaction.
        const record = this.dependencies.bindingRepo.upsert({
          binding_id: bindingId,
          workspace_id: workspace.workspace_id,
          provider_type: parsed.provider_type,
          base_url: parsed.base_url,
          api_key: parsed.api_key,
          model: parsed.model,
          config: parsed.config,
          enable_tools: parsed.enable_tools
        });
        this.dependencies.workspaceRepo.updateDefaultEngineBinding(
          workspace.workspace_id,
          bindingId
        );
        return record;
      }
    );
  }

  public async testWorkspaceBinding(workspaceId: string, input: unknown): Promise<EngineConnectionTestResult> {
    await this.requireWorkspace(workspaceId);
    const parsed = parseEngineBindingInput(input);

    try {
      const result = await this.dependencies.engineTester.testBinding(toConversationBinding(parsed, "probe"));
      return {
        success: true,
        error: null,
        normalized_binding: {
          provider_type: result.provider_type,
          base_url: result.base_url,
          model: result.model
        },
        available_models: result.available_models
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof EngineError ? error.message : "Engine connection test failed.",
        normalized_binding: {
          provider_type: parsed.provider_type,
          base_url: parsed.base_url,
          model: parsed.model
        },
        available_models: []
      };
    }
  }

  public async resolveConversationBinding(run: Run, workspace: Workspace): Promise<EngineBinding> {
    const bindingId = run.engine_binding_id ?? workspace.default_engine_binding;

    if (bindingId === null) {
      throw new EngineError("Conversation engine is not configured.", EngineErrorKind.MODEL_ERROR);
    }

    const binding = await this.requireWorkspaceOwnedBinding(
      bindingId,
      workspace.workspace_id,
      () => new EngineError("Configured engine binding could not be found.", EngineErrorKind.MODEL_ERROR),
      () => new EngineError("Configured engine binding does not belong to this workspace.", EngineErrorKind.MODEL_ERROR)
    );

    return toConversationBinding(binding, binding.binding_id);
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);

    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    return workspace;
  }

  private async requireWorkspaceOwnedBinding<TError extends Error>(
    bindingId: string,
    workspaceId: string,
    createMissingError: () => TError,
    createMismatchError: () => TError
  ): Promise<EngineBindingRecord> {
    const binding = await this.dependencies.bindingRepo.getById(bindingId);

    if (binding === null) {
      throw createMissingError();
    }

    if (binding.workspace_id !== workspaceId) {
      throw createMismatchError();
    }

    return binding;
  }
}

function parseEngineBindingInput(input: unknown): EngineBindingInput {
  try {
    return EngineBindingInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function toConversationBinding(
  binding: Pick<EngineBindingRecord, "provider_type" | "base_url" | "api_key" | "model" | "config" | "enable_tools">,
  bindingId: string
): EngineBinding {
  return {
    binding_id: bindingId,
    provider: binding.provider_type,
    base_url: binding.base_url,
    api_key: binding.api_key,
    model: binding.model,
    config: binding.config,
    ...(binding.enable_tools !== undefined ? { enable_tools: binding.enable_tools } : {})
  };
}
