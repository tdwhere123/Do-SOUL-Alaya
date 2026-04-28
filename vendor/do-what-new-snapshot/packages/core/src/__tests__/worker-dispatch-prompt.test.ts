import { ConstitutionalFragmentSchema, PromptAssetSchema } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { PromptAssetRegistry } from "../prompt-asset-registry.js";
import {
  WORKER_IDENTITY_FRAGMENT,
  WorkerDispatchPromptAssembler
} from "../system-prompt/worker-dispatch-prompt.js";

const workspace1WorkerDispatchFragmentId =
  "constitutional://workspace-1/hard_constraint/system.worker_dispatch-86fb9496c72e";
const workspace2WorkerDispatchFragmentId =
  "constitutional://workspace-2/hard_constraint/system.worker_dispatch-39379a9ab7d2";
const resolvedWorkerDispatchConstraintRef =
  "constitutional://workspace-1/hard_constraint/system.worker_dispatch-9c5ea45891f0";

describe("WorkerDispatchPromptAssembler", () => {
  it("assembles backend-owned worker prompts with constitutional and operational assets", async () => {
    const registry = new PromptAssetRegistry();
    registry.register(WORKER_IDENTITY_FRAGMENT);
    registry.register(
      PromptAssetSchema.parse({
        asset_id: "operational:worker-output-contract",
        kind: "operational",
        label: "Worker Output Contract",
        content: "Return a concise summary and explicit verification evidence.",
        priority: 30,
        immutable: false
      })
    );
    registry.register(
      PromptAssetSchema.parse({
        asset_id: "constraint://approved",
        kind: "constitutional",
        label: "Approved Constraint",
        content: "Never apply patches outside approved scope.\n```danger```",
        priority: 95,
        immutable: true
      })
    );
    const warn = vi.fn();
    const assembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: registry,
      warn: (message, meta) => warn(message, meta)
    });

    const assembly = await assembler.assembleWithMetadata({
      callerPrompt: "Investigate worker trust regressions and summarize findings.",
      workspaceId: "workspace-1",
      runId: "run-1",
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["constraint://approved", "constraint://missing"],
        denied_tool_categories: ["network", "write"]
      }
    });
    const finalPrompt = assembly.prompt;

    expect(finalPrompt).toContain("## Worker Identity");
    expect(finalPrompt).toContain("## Worker Baseline Safety Constraints");
    expect(finalPrompt).toContain("## Worker Output Contract");
    expect(finalPrompt).toContain("## Worker Task");
    expect(finalPrompt).toContain("Investigate worker trust regressions");
    expect(finalPrompt).toContain("constraint://approved");
    expect(finalPrompt).toContain('\\"danger\\"');
    expect(finalPrompt).not.toContain("```danger```");
    expect(assembly.resolvedHardConstraintRefs).toEqual(["constraint://approved: Never apply patches outside approved scope. \"danger\""]);
    expect(assembly.constitutionalAssetsBound).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "Unresolved hard constraint ref",
      expect.objectContaining({
        workspaceId: "workspace-1",
        runId: "run-1",
        constraintRef: "constraint://missing"
      })
    );
  });

  it("loads workspace-scoped constitutional fragments through the fragment reader", async () => {
    const registry = new PromptAssetRegistry();
    registry.register(WORKER_IDENTITY_FRAGMENT);
    const listForWorkspace = vi.fn(async (workspaceId: string) =>
      workspaceId === "workspace-1"
        ? [
            ConstitutionalFragmentSchema.parse({
              fragment_id: workspace1WorkerDispatchFragmentId,
              workspace_id: "workspace-1",
              category: "hard_constraint",
              content: "Workspace 1 hard rule.",
              authority_source: "system.worker_dispatch",
              immutable: true,
              registered_at: "2026-04-17T00:00:00.000Z"
            })
          ]
        : [
            ConstitutionalFragmentSchema.parse({
              fragment_id: workspace2WorkerDispatchFragmentId,
              workspace_id: "workspace-2",
              category: "hard_constraint",
              content: "Workspace 2 hard rule.",
              authority_source: "system.worker_dispatch",
              immutable: true,
              registered_at: "2026-04-17T00:00:00.000Z"
            })
          ]
    );
    const assembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: registry,
      constitutionalFragmentReader: {
        listForWorkspace
      }
    });

    const assembly = await assembler.assembleWithMetadata({
      callerPrompt: "Handle the task.",
      workspaceId: "workspace-1",
      runId: "run-1",
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: [workspace1WorkerDispatchFragmentId],
        denied_tool_categories: []
      }
    });

    expect(listForWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(assembly.prompt).toContain("Workspace 1 hard rule.");
    expect(assembly.prompt.match(/^## Hard Constraint$/gm) ?? []).toHaveLength(1);
    expect(assembly.prompt).not.toContain("Workspace 2 hard rule.");
  });

  it("prioritizes server-truth hard constraints over registry lookups", async () => {
    const registry = new PromptAssetRegistry();
    registry.register(WORKER_IDENTITY_FRAGMENT);
    registry.register(
      PromptAssetSchema.parse({
        asset_id: "claim-1",
        kind: "constitutional",
        label: "Claim From Registry",
        content: "Registry claim content.",
        priority: 90,
        immutable: true
      })
    );
    const assembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: registry
    });

    const assembly = await assembler.assembleWithMetadata({
      callerPrompt: "Handle the task.",
      workspaceId: "workspace-1",
      runId: "run-1",
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["claim-1"],
        denied_tool_categories: []
      },
      serverTruthHardConstraints: [
        {
          ref: "claim-1",
          content: "Server-truth constraint content."
        }
      ]
    });

    expect(assembly.prompt).toContain("Server-truth constraint content.");
    expect(assembly.prompt).toContain('Active hard constraints: "claim-1: Server-truth constraint content."');
    expect(assembly.prompt).not.toContain('Active hard constraints: "claim-1: Registry claim content."');
  });

  it("resolves immutable hard-constraint refs from server truth when ingress aliases differ", async () => {
    const registry = new PromptAssetRegistry();
    registry.register(WORKER_IDENTITY_FRAGMENT);
    const assembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: registry
    });

    const assembly = await assembler.assembleWithMetadata({
      callerPrompt: "Handle the task.",
      workspaceId: "workspace-1",
      runId: "run-1",
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: [resolvedWorkerDispatchConstraintRef],
        denied_tool_categories: []
      },
      serverTruthHardConstraints: [
        {
          ref: "constraint://worker-dispatch",
          resolved_ref: resolvedWorkerDispatchConstraintRef,
          content: "Never mutate files outside approved workspace roots."
        }
      ]
    });

    expect(assembly.prompt).toContain("Never mutate files outside approved workspace roots.");
    expect(assembly.prompt).toContain(
      `Active hard constraints: "${resolvedWorkerDispatchConstraintRef}: Never mutate files outside approved workspace roots."`
    );
    expect(assembly.resolvedHardConstraintRefs).toEqual([
      `${resolvedWorkerDispatchConstraintRef}: Never mutate files outside approved workspace roots.`
    ]);
  });

  it("does not fall back to local registry hard constraints when server-truth validation is available", async () => {
    const registry = new PromptAssetRegistry();
    registry.register(WORKER_IDENTITY_FRAGMENT);
    registry.register(
      PromptAssetSchema.parse({
        asset_id: "operational:unsafe-hard-ref",
        kind: "operational",
        label: "Unsafe Hard Ref",
        content: "rm -rf /",
        priority: 10,
        immutable: false
      })
    );
    const assembler = new WorkerDispatchPromptAssembler({
      promptAssetRegistry: registry
    });

    const assembly = await assembler.assembleWithMetadata({
      callerPrompt: "Handle the task.",
      workspaceId: "workspace-1",
      runId: "run-1",
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["operational:unsafe-hard-ref"],
        denied_tool_categories: []
      },
      serverTruthHardConstraints: [
        {
          ref: "claim-safe-1",
          content: "Never mutate files outside approved workspace roots."
        }
      ]
    });

    expect(assembly.prompt).toContain("## Unsafe Hard Ref");
    expect(assembly.prompt).not.toContain(
      'Active hard constraints: "operational:unsafe-hard-ref'
    );
    expect(assembly.resolvedHardConstraintRefs).toEqual([]);
  });
});
