import { describe, expect, it, vi } from "vitest";
import type { ToolSpec } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import {
  ToolSpecService,
  type ToolSpecServiceDependencies,
  type ToolSpecServiceRepoPort
} from "../tool-spec-service.js";

function createToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: "tools.read_file",
    category: "read",
    description: "Read a file from the workspace.",
    scope_guard: "workspace",
    read_only: true,
    destructive: false,
    concurrency_safe: true,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: true,
    ...overrides
  };
}

function createDependencies(seedSpecs: readonly ToolSpec[] = []): {
  readonly dependencies: ToolSpecServiceDependencies;
  readonly repo: ToolSpecServiceRepoPort;
} {
  const specs = new Map(seedSpecs.map((spec) => [spec.tool_id, { ...spec }]));

  const repo: ToolSpecServiceRepoPort = {
    insert: vi.fn(async (spec) => {
      const inserted = { ...spec };
      specs.set(spec.tool_id, inserted);
      return inserted;
    }),
    update: vi.fn(async (spec) => {
      const updated = { ...spec };
      specs.set(spec.tool_id, updated);
      return updated;
    }),
    findById: vi.fn(async (toolId) => specs.get(toolId) ?? null),
    list: vi.fn(async () =>
      [...specs.values()].sort((left, right) => left.tool_id.localeCompare(right.tool_id))
    )
  };

  return {
    dependencies: {
      toolSpecRepo: repo
    },
    repo
  };
}

describe("ToolSpecService", () => {
  it("registers a valid tool spec through the repo and returns a frozen record", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies();
    const service = new ToolSpecService(dependencies);

    const registered = await service.register(spec);

    expect(repo.insert).toHaveBeenCalledWith(spec);
    expect(registered).toEqual(spec);
    expect(Object.isFrozen(registered)).toBe(true);
  });

  it("rejects register when fast_path_eligible is true but read_only is false", async () => {
    const { dependencies, repo } = createDependencies();
    const service = new ToolSpecService(dependencies);

    await expect(
      service.register(
        createToolSpec({
          category: "write",
          read_only: false,
          fast_path_eligible: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("rejects register when requires_confirmation is true for a read-only tool", async () => {
    const { dependencies, repo } = createDependencies();
    const service = new ToolSpecService(dependencies);

    await expect(
      service.register(
        createToolSpec({
          requires_confirmation: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("rejects register when a destructive tool is categorized as read", async () => {
    const { dependencies, repo } = createDependencies();
    const service = new ToolSpecService(dependencies);

    await expect(
      service.register(
        createToolSpec({
          destructive: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("rejects register when a destructive tool is marked fast-path eligible", async () => {
    const { dependencies, repo } = createDependencies();
    const service = new ToolSpecService(dependencies);

    await expect(
      service.register(
        createToolSpec({
          category: "write",
          read_only: true,
          destructive: true,
          fast_path_eligible: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("updates a valid tool spec through the repo and returns a frozen record", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    const updated = await service.update(
      createToolSpec({
        description: "Read a file after update."
      })
    );

    expect(repo.update).toHaveBeenCalledWith(
      createToolSpec({
        description: "Read a file after update."
      })
    );
    expect(repo.findById).not.toHaveBeenCalled();
    expect(updated.description).toBe("Read a file after update.");
    expect(Object.isFrozen(updated)).toBe(true);
  });

  it("rejects update when fast_path_eligible is true but read_only is false", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    await expect(
      service.update(
        createToolSpec({
          category: "write",
          read_only: false,
          fast_path_eligible: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("rejects update when requires_confirmation is true for a read-only tool", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    await expect(
      service.update(
        createToolSpec({
          requires_confirmation: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("rejects update when a destructive tool is categorized as read", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    await expect(
      service.update(
        createToolSpec({
          destructive: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("rejects update when a destructive tool is marked fast-path eligible", async () => {
    const spec = createToolSpec();
    const { dependencies, repo } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    await expect(
      service.update(
        createToolSpec({
          category: "write",
          read_only: true,
          destructive: true,
          fast_path_eligible: true
        })
      )
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("propagates repo-owned NOT_FOUND on update without a separate existence pre-read", async () => {
    const { dependencies, repo } = createDependencies();
    vi.mocked(repo.update).mockRejectedValueOnce(new CoreError("NOT_FOUND", "Tool spec not found"));
    const service = new ToolSpecService(dependencies);

    await expect(service.update(createToolSpec())).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    expect(repo.update).toHaveBeenCalledWith(createToolSpec());
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("findById throws NOT_FOUND for a missing tool spec", async () => {
    const { dependencies } = createDependencies();
    const service = new ToolSpecService(dependencies);

    await expect(service.findById("tools.missing")).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("findById returns a frozen tool spec when present", async () => {
    const spec = createToolSpec();
    const { dependencies } = createDependencies([spec]);
    const service = new ToolSpecService(dependencies);

    const found = await service.findById(spec.tool_id);

    expect(found).toEqual(spec);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it("does not expose a Wave 1 node-template binding API", () => {
    const { dependencies } = createDependencies();
    const service = new ToolSpecService(dependencies) as ToolSpecService & {
      bindToNodeTemplate?: unknown;
    };

    expect("bindToNodeTemplate" in service).toBe(false);
    expect(service.bindToNodeTemplate).toBeUndefined();
  });
});
