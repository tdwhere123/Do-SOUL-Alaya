import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  alayaMcpSurfaceDescriptor,
  findMcpResourceDescriptor,
  invokeMcpTool,
  mcpResourceDescriptors,
  mcpToolDescriptors
} from "../mcp/index.js";
import type { AlayaIntegrationRuntimeBoundary } from "../integration/index.js";
import type { AuditedProviderSelectionInput } from "../runtime/types.js";

describe("MCP surface descriptors", () => {
  it("classifies context pack and projection resources as non-durable runtime projections", () => {
    const contextPack = findMcpResourceDescriptor("alaya.runtime.context_pack");
    const topologyProjection = findMcpResourceDescriptor("alaya.runtime.topology_projection");

    expect(contextPack?.classification).toMatchObject({
      durableTruth: false,
      kind: "runtime_projection",
      mayClaimDurableTruth: false,
      truthPlane: "runtime_control_plane"
    });
    expect(topologyProjection?.classification).toMatchObject({
      durableTruth: false,
      kind: "runtime_projection",
      mayClaimDurableTruth: false,
      truthPlane: "runtime_control_plane"
    });

    expect(
      mcpResourceDescriptors.filter(
        (resource) => resource.classification.kind === "runtime_projection"
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "alaya.runtime.context_pack"
        }),
        expect.objectContaining({
          name: "alaya.runtime.topology_projection"
        })
      ])
    );
  });

  it("keeps durable ontology, runtime projection, and audit/status resources distinct", () => {
    expect(
      Object.fromEntries(
        mcpResourceDescriptors.map((resource) => [
          resource.name,
          resource.classification.kind
        ])
      )
    ).toMatchObject({
      "alaya.audit.trust_summary": "audit_status",
      "alaya.ontology.memory": "durable_ontology",
      "alaya.runtime.context_pack": "runtime_projection",
      "alaya.runtime.topology_projection": "runtime_projection",
      "alaya.status.doctor": "audit_status"
    });
  });

  it("describes MCP tools with runtime capability and strictness metadata", () => {
    expect(alayaMcpSurfaceDescriptor.protocol).toBe("mcp-descriptor-no-sdk");
    expect(alayaMcpSurfaceDescriptor.runtimeBoundary).toBe("injected_runtime_operation");
    expect(mcpToolDescriptors).toContainEqual(
      expect.objectContaining({
        capability: "provider_selection",
        durableTruthProduced: false,
        name: "alaya.provider.select",
        runtimeBoundary: "injected_runtime_operation",
        strictness: expect.objectContaining({
          mode: "fail_closed_capable",
          strictActivation: "explicit_only"
        })
      })
    );
  });

  it("invokes MCP tools through an injected runtime operation boundary", async () => {
    const input: AuditedProviderSelectionInput = {
      evidence: [
        {
          kind: "test",
          ref: "mcp-surface.test"
        }
      ],
      providers: [
        {
          capabilities: ["embedding"],
          config_ref: "config://provider/mock",
          health: {
            checked_at: null,
            reason: null,
            status: "enabled"
          },
          model_ref: "mock-embedding",
          priority: 1,
          provider_id: "provider-mock",
          provider_kind: "mock",
          scope_refs: null
        }
      ],
      request: {
        capability: "embedding",
        required: true,
        scope_ref: "workspace-1"
      },
      source: {
        kind: "test",
        ref: "mcp-surface.test"
      },
      workspaceId: "workspace-1"
    };
    const expected = {
      committed: true,
      mutationId: "mutation-provider",
      notification: "not_requested",
      result: {
        capability: "embedding",
        decision_id: "decision-provider",
        degraded: false,
        rejected_provider_ids: [],
        required: true,
        selected_provider: input.providers[0] ?? null,
        selection_reason: "selected provider-mock",
        status: "selected"
      }
    } as const;
    const runtime = {
      selectProvider: vi.fn(async () => expected)
    } as unknown as AlayaIntegrationRuntimeBoundary;

    const result = await invokeMcpTool(runtime, {
      input,
      metadata: {
        request_id: "mcp-test",
        token: "raw-secret"
      },
      name: "alaya.provider.select"
    });

    expect(runtime.selectProvider).toHaveBeenCalledExactlyOnceWith(input);
    expect(result).toMatchObject({
      capability: "provider_selection",
      durableTruthProduced: false,
      metadata: {
        request_id: "mcp-test",
        token: "[REDACTED]"
      },
      name: "alaya.provider.select",
      operationId: "select_provider",
      runtimeBoundary: "injected_runtime_operation"
    });
    expect(result.result).toBe(expected);
  });

  it("does not import storage or external MCP SDK packages in integration/MCP surfaces", async () => {
    const files = await collectTypeScriptFiles(
      join(process.cwd(), "src", "integration"),
      join(process.cwd(), "src", "mcp")
    );

    await Promise.all(
      files.map(async (file) => {
        const content = await readFile(file, "utf8");
        expect(content, file).not.toMatch(/\bfrom\s+["'][^"']*storage[^"']*["']/);
        expect(content, file).not.toMatch(/\bimport\s*\([^)]*storage[^)]*\)/);
        expect(content, file).not.toMatch(/@modelcontextprotocol|@ai-sdk\/mcp/);
      })
    );
  });
});

async function collectTypeScriptFiles(...roots: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectTypeScriptFiles(path));
      } else if (entry.isFile() && path.endsWith(".ts")) {
        files.push(path);
      }
    }
  }

  return files;
}
