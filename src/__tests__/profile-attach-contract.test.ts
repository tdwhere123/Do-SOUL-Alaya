import { describe, expect, it } from "vitest";
import {
  buildProfileAttachResult,
  buildProfileAttachSessionEventMetadata,
  buildProfileTargetWritePreview,
  getProfileAttachTargetSnippet,
  profileAttachTargetSnippets
} from "../profile/attach.js";

const now = "2026-04-28T00:00:00.000Z";

describe("Attach/Profile target contract", () => {
  it("builds Codex and Claude Code previews with path, scope, target, conflict, and rollback hint", () => {
    const codex = buildProfileTargetWritePreview({
      actor: "operator",
      current_config: {
        alaya_mcp_enabled: false,
        instruction_ref: "existing-codex-rules"
      },
      file_path: "/repo/.codex/AGENTS.md",
      preview_id: "preview-codex-project",
      profile_scope: "project",
      proposed_config: {
        alaya_mcp_enabled: true,
        instruction_ref: "alaya-codex-rules"
      },
      requested_at: now,
      rollback_hint: "Restore /repo/.codex/AGENTS.md from the generated backup or remove the Alaya block.",
      scope_ref: "project:/repo",
      target: "codex"
    });
    const claude = buildProfileTargetWritePreview({
      actor: "operator",
      current_config: {},
      file_path: "/repo/CLAUDE.md",
      preview_id: "preview-claude-project",
      profile_scope: "project",
      proposed_config: {
        instruction_ref: "alaya-claude-rules"
      },
      requested_at: now,
      rollback_hint: "Remove the Alaya section from /repo/CLAUDE.md.",
      scope_ref: "project:/repo",
      target: "claude_code"
    });

    expect(codex).toMatchObject({
      target: "codex",
      profile_scope: "project",
      scope_ref: "project:/repo",
      file_path: "/repo/.codex/AGENTS.md",
      rollback_hint: "Restore /repo/.codex/AGENTS.md from the generated backup or remove the Alaya block.",
      requires_explicit_confirm: true,
      writes_durable_state: false,
      writes_memory_truth: false,
      produces_usage_proof: false
    });
    expect(codex.conflicts).toEqual([
      expect.objectContaining({
        field: "alaya_mcp_enabled",
        current_value: false,
        proposed_value: true,
        message: "Existing project value would be replaced for codex."
      }),
      expect.objectContaining({
        field: "instruction_ref",
        current_value: "existing-codex-rules",
        proposed_value: "alaya-codex-rules",
        message: "Existing project value would be replaced for codex."
      })
    ]);
    expect(claude.conflicts).toEqual([]);
    expect(claude.target).toBe("claude_code");
  });

  it("applies confirm decisions only to the exact target and scope", () => {
    const userCodex = preview("preview-user-codex", "codex", "user", "user:local", "/home/user/.codex/AGENTS.md");
    const projectCodex = preview("preview-project-codex", "codex", "project", "project:/repo", "/repo/.codex/AGENTS.md");
    const userClaude = preview("preview-user-claude", "claude_code", "user", "user:local", "/home/user/.claude/CLAUDE.md");

    const result = buildProfileAttachResult({
      decisions: [{
        actor: "operator",
        decided_at: now,
        decision: "confirm",
        decision_id: "decision-codex-user",
        profile_scope: "user",
        reason: "install user default",
        scope_ref: "user:local",
        target: "codex",
        write_audit_ref: "audit:codex-user-write",
        write_result: "succeeded"
      }],
      previews: [userCodex, projectCodex, userClaude],
      recorded_at: now,
      result_id: "attach-result-1"
    });

    expect(result.overall_status).toBe("partial");
    expect(result.records).toEqual([
      expect.objectContaining({
        preview_id: "preview-user-codex",
        target: "codex",
        profile_scope: "user",
        scope_ref: "user:local",
        status: "configured"
      }),
      expect.objectContaining({
        preview_id: "preview-project-codex",
        target: "codex",
        profile_scope: "project",
        scope_ref: "project:/repo",
        status: "skipped"
      }),
      expect.objectContaining({
        preview_id: "preview-user-claude",
        target: "claude_code",
        profile_scope: "user",
        scope_ref: "user:local",
        status: "skipped"
      })
    ]);
    expect(result.configured_targets).toEqual(["codex:user:user:local"]);
  });

  it("represents declined and partial target results without delivered or used claims", () => {
    const result = buildProfileAttachResult({
      decisions: [
        {
          actor: "operator",
          decided_at: now,
          decision: "confirm",
          decision_id: "decision-codex-project",
          profile_scope: "project",
          reason: "enable Codex for this repo",
          scope_ref: "project:/repo",
          target: "codex",
          write_audit_ref: "audit:codex-project-write",
          write_result: "succeeded"
        },
        {
          actor: "operator",
          decided_at: now,
          decision: "decline",
          decision_id: "decision-claude-project",
          profile_scope: "project",
          reason: "review Claude Code rules separately",
          scope_ref: "project:/repo",
          target: "claude_code"
        }
      ],
      previews: [
        preview("preview-codex-project", "codex", "project", "project:/repo", "/repo/.codex/AGENTS.md"),
        preview("preview-claude-project", "claude_code", "project", "project:/repo", "/repo/CLAUDE.md")
      ],
      recorded_at: now,
      result_id: "attach-result-2"
    });

    expect(result).toMatchObject({
      overall_status: "partial",
      writes_memory_truth: false,
      produces_usage_proof: false,
      claims_delivered: false,
      claims_used: false
    });
    expect(result.configured_targets).toEqual(["codex:project:project:/repo"]);
    expect(result.declined_targets).toEqual(["claude_code:project:project:/repo"]);
    expect(result.records.map((record) => record.status)).toEqual(["configured", "declined"]);
  });

  it("builds installed/configured session event metadata without usage proof", () => {
    const result = buildProfileAttachResult({
      decisions: [{
        actor: "operator",
        decided_at: now,
        decision: "confirm",
        decision_id: "decision-codex-project",
        profile_scope: "project",
        scope_ref: "project:/repo",
        target: "codex",
        write_audit_ref: "audit:codex-project-write",
        write_result: "succeeded"
      }],
      previews: [preview("preview-codex-project", "codex", "project", "project:/repo", "/repo/.codex/AGENTS.md")],
      recorded_at: now,
      result_id: "attach-result-3"
    });

    const events = buildProfileAttachSessionEventMetadata({
      event_id_prefix: "attach",
      evidence_refs: ["audit:attach-result-3"],
      recorded_at: now,
      result,
      run_id: "run-1",
      session_id: "session-1",
      source_ref: "profile:attach-result-3",
      workspace_id: "workspace-1"
    });

    expect(events.map((event) => event.type)).toEqual(["installed", "configured"]);
    expect(events.every((event) => event.evidence_refs.includes("audit:codex-project-write"))).toBe(true);
    expect(events.every((event) => event.agent_target === "codex")).toBe(true);
    expect(events.every((event) => event.profile_scope === "project")).toBe(true);
    expect(events.every((event) => event.activation_mode === "attach_profile")).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "context_delivered" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "usage_proof_recorded" }));
  });

  it("requires explicit write result and audit ref before configured evidence is minted", () => {
    expect(() => buildProfileAttachResult({
      decisions: [{
        actor: "operator",
        decided_at: now,
        decision: "confirm",
        decision_id: "decision-codex-project",
        profile_scope: "project",
        scope_ref: "project:/repo",
        target: "codex"
      }],
      previews: [preview("preview-codex-project", "codex", "project", "project:/repo", "/repo/.codex/AGENTS.md")],
      recorded_at: now,
      result_id: "attach-result-missing-write"
    })).toThrow(/write_result/);

    const failed = buildProfileAttachResult({
      decisions: [{
        actor: "operator",
        decided_at: now,
        decision: "confirm",
        decision_id: "decision-codex-project",
        failure_reason: "write_permission_denied",
        profile_scope: "project",
        scope_ref: "project:/repo",
        target: "codex",
        write_result: "failed"
      }],
      previews: [preview("preview-codex-project", "codex", "project", "project:/repo", "/repo/.codex/AGENTS.md")],
      recorded_at: now,
      result_id: "attach-result-write-failed"
    });

    expect(failed.records[0]).toMatchObject({
      failure_reason: "write_permission_denied",
      status: "failed",
      write_audit_ref: null,
      write_result: "failed"
    });
    expect(failed.session_event_types).toEqual([]);
  });

  it("exposes Codex and Claude Code target snippets for snapshot-safe previews", () => {
    expect(profileAttachTargetSnippets).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("MCP-first integration"),
        file_name: "AGENTS.md",
        requires_explicit_confirm: true,
        target: "codex",
        writes_memory_truth: false
      }),
      expect.objectContaining({
        content: expect.stringContaining("local memory recall"),
        file_name: "CLAUDE.md",
        requires_explicit_confirm: true,
        target: "claude_code",
        writes_memory_truth: false
      })
    ]);
    expect(getProfileAttachTargetSnippet("codex").content).toContain("Do not write durable memory truth directly");
  });
});

function preview(
  previewId: string,
  target: "codex" | "claude_code",
  profileScope: "user" | "project",
  scopeRef: string,
  filePath: string
) {
  return buildProfileTargetWritePreview({
    actor: "operator",
    current_config: {},
    file_path: filePath,
    preview_id: previewId,
    profile_scope: profileScope,
    proposed_config: {
      alaya_mcp_enabled: true
    },
    requested_at: now,
    rollback_hint: `Remove the Alaya block from ${filePath}.`,
    scope_ref: scopeRef,
    target
  });
}
