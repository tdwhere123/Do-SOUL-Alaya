export function duplicateAuthorityKey(entry) {
  return `${entry.path}\0${entry.binding}\0${entry.sources.join(",")}`;
}

export function validatePolicy(policy) {
  if (policy.schema_version !== 1) {
    throw new Error("repository-structure-policy: schema_version must be 1");
  }
  if (
    !Number.isInteger(policy.file_size?.review_at) ||
    !Number.isInteger(policy.file_size?.fail_at) ||
    policy.file_size.review_at < 1 ||
    policy.file_size.fail_at <= policy.file_size.review_at
  ) {
    throw new Error("repository-structure-policy: require 0 < file review_at < fail_at");
  }
  if (
    !Number.isInteger(policy.function_size?.review_at) ||
    !Number.isInteger(policy.function_size?.split_review_at) ||
    policy.function_size.review_at < 1 ||
    policy.function_size.split_review_at <= policy.function_size.review_at
  ) {
    throw new Error("repository-structure-policy: require 0 < function review_at < split_review_at");
  }
  if (!Number.isInteger(policy.directory_size?.advisory_at) || policy.directory_size.advisory_at < 1) {
    throw new Error("repository-structure-policy: directory advisory_at must be a positive integer");
  }
  for (const field of [
    "forbidden_ownership_directories",
    "forbidden_rollout_directory_patterns",
    "workspaces",
    "runtime_artifact_roots",
    "artifact_reference_fragments",
    "retired_import_paths",
    "entry_exports"
  ]) {
    if (!Array.isArray(policy[field]) || policy[field].length === 0) {
      throw new Error(`repository-structure-policy: ${field} must be a non-empty array`);
    }
  }
  validateUniqueStrings("forbidden_ownership_directories", policy.forbidden_ownership_directories);
  validateUniqueStrings("forbidden_rollout_directory_patterns", policy.forbidden_rollout_directory_patterns);
  validateUniqueStrings("runtime_artifact_roots", policy.runtime_artifact_roots);
  if (!Array.isArray(policy.artifact_scan_exempt_roots)) {
    throw new Error("repository-structure-policy: artifact_scan_exempt_roots must be an array");
  }
  validateUniqueStrings("artifact_scan_exempt_roots", policy.artifact_scan_exempt_roots);
  validateUniqueStrings("artifact_reference_fragments", policy.artifact_reference_fragments);
  validateUniqueStrings("retired_import_paths", policy.retired_import_paths);
  for (const pattern of policy.forbidden_rollout_directory_patterns) new RegExp(pattern, "u");
  validateWorkspaces(policy.workspaces);
  validateEntryExports(policy.entry_exports);
  validatePrivateBarrelSnapshot(policy.private_barrel_snapshot);
  validateDuplicateAuthorities(policy.existing_duplicate_export_authorities);
  validateUniqueStrings("existing_index_to_index_edges", policy.existing_index_to_index_edges);
  for (const edge of policy.existing_index_to_index_edges) {
    if (!/^[^\s].+ -> [^\s].+$/u.test(edge)) {
      throw new Error(`repository-structure-policy: malformed index edge ${edge}`);
    }
  }
  validateNonLiteralExceptions(policy.existing_non_literal_module_specifier_exceptions);
  const classificationKinds = new Set(["handwritten", "generated", "declarative", "test_support"]);
  for (const [file, classification] of Object.entries(policy.file_size.classifications)) {
    if (!classificationKinds.has(classification.kind) || classification.reason.trim().length === 0) {
      throw new Error(
        `repository-structure-policy: ${file} needs a supported classification and non-empty reason`
      );
    }
  }
  const fragments = new Set(policy.artifact_reference_fragments);
  for (const [file, exception] of Object.entries(policy.existing_artifact_reference_exceptions)) {
    if (exception.reason.trim().length === 0) {
      throw new Error(`repository-structure-policy: ${file} artifact exception needs a reason`);
    }
    const limits = exception.max_occurrences_by_fragment;
    for (const fragment of fragments) {
      if (!Number.isInteger(limits[fragment]) || limits[fragment] < 0) {
        throw new Error(
          `repository-structure-policy: ${file} needs a non-negative limit for ${fragment}`
        );
      }
    }
    for (const fragment of Object.keys(limits)) {
      if (!fragments.has(fragment)) {
        throw new Error(
          `repository-structure-policy: ${file} has an unknown artifact fragment ${fragment}`
        );
      }
    }
  }
}

export function validateFileClassifications(policy, fileSet) {
  for (const file of Object.keys(policy.file_size.classifications)) {
    if (fileSet.has(file)) continue;
    throw new Error(
      `repository-structure-policy: classified path is not in the guarded source set: ${file}`
    );
  }
}

export function validateEntryExportPaths(policy, fileSet) {
  for (const entry of policy.entry_exports) {
    if (fileSet.has(entry.path)) continue;
    throw new Error(
      `repository-structure-policy: entry export path is not in the guarded source set: ${entry.path}`
    );
  }
}

function validateUniqueStrings(field, values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`repository-structure-policy: ${field} must contain non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`repository-structure-policy: ${field} must not contain duplicates`);
  }
}

function validateWorkspaces(workspaces) {
  const roots = workspaces.map((workspace) => workspace.root);
  const packages = workspaces.map((workspace) => workspace.package);
  validateUniqueStrings("workspace roots", roots);
  validateUniqueStrings("workspace packages", packages);
  for (const workspace of workspaces) {
    validateUniqueStrings(
      `allowed packages for ${workspace.package}`,
      workspace.allowed_workspace_packages
    );
  }
}

function validateEntryExports(entries) {
  validateUniqueStrings("entry export specifiers", entries.map((entry) => entry.specifier));
  validateUniqueStrings("entry export paths", entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (!Number.isInteger(entry.expected_count) || entry.expected_count < 0) {
      throw new Error(`repository-structure-policy: invalid export count for ${entry.specifier}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.expected_sha256)) {
      throw new Error(`repository-structure-policy: invalid export digest for ${entry.specifier}`);
    }
  }
}

function validatePrivateBarrelSnapshot(snapshot) {
  if (!Number.isInteger(snapshot?.expected_count) || snapshot.expected_count < 0) {
    throw new Error("repository-structure-policy: invalid private barrel count");
  }
  if (!/^[a-f0-9]{64}$/u.test(snapshot.expected_sha256)) {
    throw new Error("repository-structure-policy: invalid private barrel digest");
  }
}

function validateDuplicateAuthorities(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("repository-structure-policy: duplicate authority exceptions must be an array");
  }
  const keys = [];
  for (const entry of entries) {
    if (typeof entry.path !== "string" || typeof entry.binding !== "string") {
      throw new Error("repository-structure-policy: duplicate authority exception needs path and binding");
    }
    validateUniqueStrings(`duplicate sources for ${entry.binding}`, entry.sources);
    if (entry.sources.length < 2) {
      throw new Error(`repository-structure-policy: ${entry.binding} needs at least two sources`);
    }
    keys.push(duplicateAuthorityKey(entry));
  }
  validateUniqueStrings("duplicate authority exceptions", keys);
}

function validateNonLiteralExceptions(entries) {
  if (!Array.isArray(entries)) {
    throw new Error(
      "repository-structure-policy: existing_non_literal_module_specifier_exceptions must be an array"
    );
  }
  const paths = [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || entry.path.length === 0) {
      throw new Error("repository-structure-policy: non-literal exception needs a path");
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(
        `repository-structure-policy: ${entry.path} non-literal exception needs a reason`
      );
    }
    paths.push(entry.path);
  }
  validateUniqueStrings("existing_non_literal_module_specifier_exceptions", paths);
}
