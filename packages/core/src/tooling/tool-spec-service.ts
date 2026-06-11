import { ToolSpecSchema, type ToolSpec } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";

export interface ToolSpecServiceRepoPort {
  insert(spec: ToolSpec): Promise<Readonly<ToolSpec>>;
  update(spec: ToolSpec): Promise<Readonly<ToolSpec>>;
  findById(toolId: string): Promise<Readonly<ToolSpec> | null>;
  list(): Promise<readonly Readonly<ToolSpec>[]>;
  delete?(toolId: string): Promise<void>;
}

export interface ToolSpecServiceDependencies {
  readonly toolSpecRepo: ToolSpecServiceRepoPort;
}

export class ToolSpecService {
  public constructor(private readonly deps: ToolSpecServiceDependencies) {}

  public async register(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    const parsedSpec = parseToolSpec(spec);
    this.validateInvariants(parsedSpec);

    return parseToolSpec(await this.deps.toolSpecRepo.insert(parsedSpec));
  }

  public async update(spec: ToolSpec): Promise<Readonly<ToolSpec>> {
    const parsedSpec = parseToolSpec(spec);
    this.validateInvariants(parsedSpec);

    return parseToolSpec(await this.deps.toolSpecRepo.update(parsedSpec));
  }

  public async findById(toolId: string): Promise<Readonly<ToolSpec>> {
    const spec = await this.deps.toolSpecRepo.findById(toolId);

    if (spec === null) {
      throw new CoreError("NOT_FOUND", "Tool spec not found");
    }

    return parseToolSpec(spec);
  }

  public async list(): Promise<readonly Readonly<ToolSpec>[]> {
    return Object.freeze((await this.deps.toolSpecRepo.list()).map((spec) => parseToolSpec(spec)));
  }

  public async delete(toolId: string): Promise<void> {
    const parsedToolId = parseNonEmptyString(toolId, "toolId");

    if (this.deps.toolSpecRepo.delete === undefined) {
      throw new CoreError("CONFLICT", `Tool spec deletion is unavailable for ${parsedToolId}.`);
    }

    await this.deps.toolSpecRepo.delete(parsedToolId);
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
