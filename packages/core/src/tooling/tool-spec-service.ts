import { ToolSpecSchema, type ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { deepFreeze } from "@do-soul/alaya-protocol";
import { parseNonEmptyString } from "../shared/validators.js";

export interface ToolSpecServiceRepoPort {
  insertSync(spec: ToolSpec): Readonly<ToolSpec>;
  updateSync(spec: ToolSpec): Readonly<ToolSpec>;
  findByIdSync(toolId: string): Readonly<ToolSpec> | null;
  list(): Promise<readonly Readonly<ToolSpec>[]>;
  deleteSync?(toolId: string): void;
}

export interface ToolSpecServiceDependencies {
  readonly toolSpecRepo: ToolSpecServiceRepoPort;
}

export class ToolSpecService {
  public constructor(private readonly deps: ToolSpecServiceDependencies) {}

  public async register(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    return this.registerSync(spec);
  }

  public registerSync(spec: ToolSpec): Readonly<ToolSpec> {
    const parsedSpec = parseToolSpec(spec);
    this.validateInvariants(parsedSpec);
    return parseToolSpec(this.deps.toolSpecRepo.insertSync(parsedSpec));
  }

  public async update(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    return this.updateSync(spec);
  }

  public updateSync(spec: ToolSpec): Readonly<ToolSpec> {
    const parsedSpec = parseToolSpec(spec);
    this.validateInvariants(parsedSpec);
    return parseToolSpec(this.deps.toolSpecRepo.updateSync(parsedSpec));
  }

  public async findById(toolId: string): Promise<Readonly<ToolSpec>> {
    return this.findByIdSync(toolId);
  }

  public findByIdSync(toolId: string): Readonly<ToolSpec> {
    const spec = this.deps.toolSpecRepo.findByIdSync(toolId);

    if (spec === null) {
      throw new CoreError("NOT_FOUND", "Tool spec not found");
    }

    return parseToolSpec(spec);
  }

  public async list(): Promise<readonly Readonly<ToolSpec>[]> {
    return Object.freeze((await this.deps.toolSpecRepo.list()).map((spec) => parseToolSpec(spec)));
  }

  public async delete(toolId: string): Promise<void> {
    this.deleteSync(toolId);
  }

  public deleteSync(toolId: string): void {
    const parsedToolId = parseNonEmptyString(toolId, "toolId");

    if (this.deps.toolSpecRepo.deleteSync === undefined) {
      throw new CoreError("CONFLICT", `Tool spec deletion is unavailable for ${parsedToolId}.`);
    }

    this.deps.toolSpecRepo.deleteSync(parsedToolId);
  }

  private validateInvariants(spec: Readonly<ToolSpec>): void {
    if (spec.fast_path_eligible && !spec.read_only) {
      throw new CoreError("VALIDATION", "fast_path_eligible tools must be read_only");
    }

    if (spec.destructive && spec.fast_path_eligible) {
      throw new CoreError("VALIDATION", "destructive tools must not be fast_path_eligible");
    }

    if (spec.requires_confirmation && spec.read_only) {
      throw new CoreError("VALIDATION", "requires_confirmation tools must not be read_only");
    }

    if (spec.destructive && (spec.category === "read" || spec.category === "evidence")) {
      throw new CoreError("VALIDATION", "destructive tools cannot use read or evidence categories");
    }
  }
}

function parseToolSpec(value: ToolSpec): Readonly<ToolSpec> {
  try {
    return deepFreeze(ToolSpecSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid tool spec payload", { cause: error });
  }
}
