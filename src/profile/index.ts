import {
  assertIsoDatetime,
  assertObject,
  assertOneOf,
  assertText
} from "../foundation/validation.js";

export const profileConfigSources = ["runtime_default", "user", "environment", "project"] as const;
export type ProfileConfigSource = (typeof profileConfigSources)[number];

export const profileScopes = ["user", "project"] as const;
export type ProfileScope = (typeof profileScopes)[number];

export type ProfileConfigScalar = string | number | boolean | null;
export type ProfileConfigValue = ProfileConfigScalar | readonly ProfileConfigScalar[];
export type ProfileConfigMap = Readonly<Record<string, ProfileConfigValue | undefined>>;

export interface ResolveProfileConfigInput {
  readonly runtime_default?: ProfileConfigMap;
  readonly user?: ProfileConfigMap;
  readonly environment?: ProfileConfigMap;
  readonly project?: ProfileConfigMap;
  readonly user_scope_ref?: string | null;
  readonly project_scope_ref?: string | null;
}

export interface ProfileConfigSourceRecord {
  readonly source: ProfileConfigSource;
  readonly scope_ref: string | null;
}

export interface EffectiveProfileConfig {
  readonly values: Readonly<Record<string, ProfileConfigValue>>;
  readonly sources: Readonly<Record<string, ProfileConfigSourceRecord>>;
  readonly precedence: readonly ProfileConfigSource[];
}

export interface ProfileConfigDiffEntry {
  readonly field: string;
  readonly old_present: boolean;
  readonly old_value: ProfileConfigValue | null;
  readonly new_present: boolean;
  readonly new_value: ProfileConfigValue | null;
}

export interface BuildProfileChangePreviewInput {
  readonly preview_id: string;
  readonly actor: string;
  readonly profile_scope: ProfileScope;
  readonly scope_ref: string;
  readonly current_config: ProfileConfigMap;
  readonly proposed_config: ProfileConfigMap;
  readonly reason?: string | null;
  readonly requested_at: string;
}

export interface ProfileChangePreview {
  readonly preview_id: string;
  readonly actor: string;
  readonly profile_scope: ProfileScope;
  readonly scope_ref: string;
  readonly reason: string | null;
  readonly requested_at: string;
  readonly writes_durable_state: false;
  readonly requires_explicit_confirm: true;
  readonly changes: readonly ProfileConfigDiffEntry[];
  readonly conflicts: readonly ProfileConfigDiffEntry[];
}

export interface BuildProjectOverrideChangeRecordInput {
  readonly change_id: string;
  readonly actor: string;
  readonly project_scope_ref: string;
  readonly old_config: ProfileConfigMap;
  readonly new_config: ProfileConfigMap;
  readonly reason?: string | null;
  readonly preview_id?: string | null;
  readonly recorded_at: string;
}

export interface ProfileChangeRecord {
  readonly change_id: string;
  readonly actor: string;
  readonly profile_scope: "project";
  readonly project_scope_ref: string;
  readonly reason: string | null;
  readonly preview_id: string | null;
  readonly recorded_at: string;
  readonly auditable: true;
  readonly changed_fields: readonly string[];
  readonly old_values: Readonly<Record<string, ProfileConfigValue | null>>;
  readonly new_values: Readonly<Record<string, ProfileConfigValue | null>>;
}

export function resolveProfileConfig(input: ResolveProfileConfigInput): EffectiveProfileConfig {
  assertObject(input, "ResolveProfileConfigInput");
  const typedInput = input as ResolveProfileConfigInput;
  const emptyConfig: ProfileConfigMap = {};
  const userScopeRef = normalizeNullableText(typedInput.user_scope_ref, "user_scope_ref");
  const projectScopeRef = normalizeNullableText(typedInput.project_scope_ref, "project_scope_ref");
  const values: Record<string, ProfileConfigValue> = {};
  const sources: Record<string, ProfileConfigSourceRecord> = {};

  for (const layer of [
    { source: "runtime_default" as const, values: typedInput.runtime_default ?? emptyConfig, scope_ref: null },
    { source: "user" as const, values: typedInput.user ?? emptyConfig, scope_ref: userScopeRef },
    { source: "environment" as const, values: typedInput.environment ?? emptyConfig, scope_ref: null },
    { source: "project" as const, values: typedInput.project ?? emptyConfig, scope_ref: projectScopeRef }
  ]) {
    for (const [field, value] of sortedConfigEntries(layer.values)) {
      values[field] = cloneProfileConfigValue(value);
      sources[field] = {
        scope_ref: layer.scope_ref,
        source: layer.source
      };
    }
  }

  return {
    precedence: profileConfigSources,
    sources,
    values
  };
}

export function buildProfileChangePreview(input: BuildProfileChangePreviewInput): ProfileChangePreview {
  assertObject(input, "BuildProfileChangePreviewInput");
  assertText(input.preview_id, "preview_id");
  assertText(input.actor, "actor");
  assertOneOf(input.profile_scope, profileScopes, "profile_scope");
  assertText(input.scope_ref, "scope_ref");
  assertIsoDatetime(input.requested_at, "requested_at");
  const changes = diffProfileConfig(input.current_config, input.proposed_config);

  return {
    actor: input.actor,
    changes,
    conflicts: changes.filter((entry) => entry.old_present),
    preview_id: input.preview_id,
    profile_scope: input.profile_scope,
    reason: normalizeNullableText(input.reason, "reason"),
    requested_at: input.requested_at,
    requires_explicit_confirm: true,
    scope_ref: input.scope_ref,
    writes_durable_state: false
  };
}

export function buildProjectOverrideChangeRecord(
  input: BuildProjectOverrideChangeRecordInput
): ProfileChangeRecord {
  assertObject(input, "BuildProjectOverrideChangeRecordInput");
  assertText(input.change_id, "change_id");
  assertText(input.actor, "actor");
  assertText(input.project_scope_ref, "project_scope_ref");
  assertIsoDatetime(input.recorded_at, "recorded_at");
  const reason = normalizeNullableText(input.reason, "reason");
  const previewId = normalizeNullableText(input.preview_id, "preview_id");
  if (reason === null && previewId === null) {
    throw new TypeError("project override requires reason or preview_id.");
  }

  const changes = diffProfileConfig(input.old_config, input.new_config);
  if (changes.length === 0) {
    throw new TypeError("project override requires at least one changed field.");
  }

  return {
    actor: input.actor,
    auditable: true,
    change_id: input.change_id,
    changed_fields: changes.map((entry) => entry.field),
    new_values: valuesByField(changes, "new"),
    old_values: valuesByField(changes, "old"),
    preview_id: previewId,
    profile_scope: "project",
    project_scope_ref: input.project_scope_ref,
    reason,
    recorded_at: input.recorded_at
  };
}

function diffProfileConfig(oldConfig: ProfileConfigMap, newConfig: ProfileConfigMap): readonly ProfileConfigDiffEntry[] {
  assertObject(oldConfig, "old_config");
  assertObject(newConfig, "new_config");
  const oldEntries = normalizedConfigMap(oldConfig);
  const newEntries = normalizedConfigMap(newConfig);
  const fields = [...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])].sort();
  const changes: ProfileConfigDiffEntry[] = [];

  for (const field of fields) {
    const oldPresent = Object.prototype.hasOwnProperty.call(oldEntries, field);
    const newPresent = Object.prototype.hasOwnProperty.call(newEntries, field);
    const oldValue = oldPresent ? oldEntries[field] ?? null : null;
    const newValue = newPresent ? newEntries[field] ?? null : null;
    if (oldPresent !== newPresent || !sameProfileConfigValue(oldValue, newValue)) {
      changes.push({
        field,
        new_present: newPresent,
        new_value: cloneProfileConfigValue(newValue),
        old_present: oldPresent,
        old_value: cloneProfileConfigValue(oldValue)
      });
    }
  }

  return changes;
}

function sortedConfigEntries(config: ProfileConfigMap): readonly (readonly [string, ProfileConfigValue])[] {
  return Object.entries(normalizedConfigMap(config)).sort(([left], [right]) => left.localeCompare(right));
}

function normalizedConfigMap(config: ProfileConfigMap): Record<string, ProfileConfigValue> {
  assertObject(config, "ProfileConfigMap");
  const normalized: Record<string, ProfileConfigValue> = {};

  for (const [field, value] of Object.entries(config)) {
    if (value === undefined) {
      continue;
    }
    assertText(field, "config field");
    normalized[field] = cloneProfileConfigValue(validateProfileConfigValue(value, field));
  }

  return normalized;
}

function validateProfileConfigValue(value: unknown, label: string): ProfileConfigValue {
  if (isProfileConfigScalar(value)) {
    return value;
  }
  if (Array.isArray(value) && value.every(isProfileConfigScalar)) {
    return value;
  }
  throw new TypeError(`${label} must be a profile config scalar or scalar array.`);
}

function cloneProfileConfigValue(value: ProfileConfigValue): ProfileConfigValue {
  return Array.isArray(value) ? [...value] : value;
}

function sameProfileConfigValue(left: ProfileConfigValue | null, right: ProfileConfigValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valuesByField(
  changes: readonly ProfileConfigDiffEntry[],
  side: "old" | "new"
): Readonly<Record<string, ProfileConfigValue | null>> {
  const values: Record<string, ProfileConfigValue | null> = {};
  for (const change of changes) {
    values[change.field] = side === "old" ? change.old_value : change.new_value;
  }
  return values;
}

function normalizeNullableText(value: string | null | undefined, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  assertText(value, label);
  return value.trim();
}

function isProfileConfigScalar(value: unknown): value is ProfileConfigScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
