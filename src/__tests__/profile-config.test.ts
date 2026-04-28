import { describe, expect, it } from "vitest";
import {
  buildProfileChangePreview,
  buildProjectOverrideChangeRecord,
  resolveProfileConfig
} from "../profile/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("profile config precedence", () => {
  it("resolves config deterministically with project scope as the winning override", () => {
    const first = resolveProfileConfig({
      runtime_default: {
        data_dir: "/default/data",
        embedding_enabled: false,
        provider_id: "default-provider"
      },
      user: {
        data_dir: "/home/user/.alaya",
        provider_id: "user-provider"
      },
      environment: {
        provider_id: "env-provider"
      },
      project: {
        provider_id: "project-provider"
      },
      project_scope_ref: "project:/repo",
      user_scope_ref: "user:local"
    });
    const second = resolveProfileConfig({
      environment: {
        provider_id: "env-provider"
      },
      project: {
        provider_id: "project-provider"
      },
      runtime_default: {
        provider_id: "default-provider",
        embedding_enabled: false,
        data_dir: "/default/data"
      },
      user: {
        provider_id: "user-provider",
        data_dir: "/home/user/.alaya"
      },
      user_scope_ref: "user:local",
      project_scope_ref: "project:/repo"
    });

    expect(first).toEqual(second);
    expect(first.values).toEqual({
      data_dir: "/home/user/.alaya",
      embedding_enabled: false,
      provider_id: "project-provider"
    });
    expect(first.sources.provider_id).toMatchObject({
      source: "project",
      scope_ref: "project:/repo"
    });
    expect(first.sources.data_dir).toMatchObject({
      source: "user",
      scope_ref: "user:local"
    });
    expect(first.sources.embedding_enabled).toMatchObject({
      source: "runtime_default",
      scope_ref: null
    });
  });

  it("builds project override audit records with actor, scope, old/new fields, and reason", () => {
    const record = buildProjectOverrideChangeRecord({
      actor: "operator",
      change_id: "profile-change-1",
      old_config: {
        provider_id: "user-provider",
        embedding_enabled: false
      },
      new_config: {
        provider_id: "project-provider",
        embedding_enabled: false
      },
      project_scope_ref: "project:/repo",
      reason: "repo requires local provider",
      recorded_at: now
    });

    expect(record).toMatchObject({
      actor: "operator",
      auditable: true,
      change_id: "profile-change-1",
      profile_scope: "project",
      project_scope_ref: "project:/repo",
      reason: "repo requires local provider",
      recorded_at: now
    });
    expect(record.changed_fields).toEqual(["provider_id"]);
    expect(record.old_values).toEqual({ provider_id: "user-provider" });
    expect(record.new_values).toEqual({ provider_id: "project-provider" });
  });

  it("previews project conflicts without writing state or mutating inputs", () => {
    const current = {
      provider_id: "user-provider",
      embedding_enabled: false
    };
    const proposed = {
      provider_id: "project-provider",
      embedding_enabled: true
    };
    const currentBefore = JSON.stringify(current);
    const proposedBefore = JSON.stringify(proposed);

    const preview = buildProfileChangePreview({
      actor: "operator",
      current_config: current,
      preview_id: "profile-preview-1",
      profile_scope: "project",
      proposed_config: proposed,
      reason: "show conflict before per-target confirm",
      scope_ref: "project:/repo",
      requested_at: now
    });

    expect(JSON.stringify(current)).toBe(currentBefore);
    expect(JSON.stringify(proposed)).toBe(proposedBefore);
    expect(preview.writes_durable_state).toBe(false);
    expect(preview.requires_explicit_confirm).toBe(true);
    expect(preview.conflicts.map((entry) => entry.field)).toEqual([
      "embedding_enabled",
      "provider_id"
    ]);
    expect(preview.changes.map((entry) => entry.field)).toEqual([
      "embedding_enabled",
      "provider_id"
    ]);
  });
});
