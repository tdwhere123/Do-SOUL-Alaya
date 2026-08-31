import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  duplicateAuthorityKey,
  validateEntryExportPaths,
  validateFileClassifications,
  validatePolicy
} from "./repository-structure-policy-schema.mjs";
import {
  addToSet,
  collectExportedBindings,
  compareText,
  countArtifactReferences,
  duplicateExportAuthorities,
  functionSpans,
  hashExportBindings,
  hashTextLines,
  lineCount,
  listGuardFiles,
  listSourceFiles,
  moduleReferences,
  parseSource,
  resolveModule,
  sourcePathMatchesRetiredPath,
  stronglyConnectedComponents,
  unresolvedModulePath
} from "./repository-structure-source-model.mjs";

export function analyzeRepositoryStructure({ root, policy }) {
  validatePolicy(policy);
  const files = listGuardFiles(root);
  const allSourceFiles = listSourceFiles(root, true);
  const fileSet = new Set(files);
  validateFileClassifications(policy, fileSet);
  validateEntryExportPaths(policy, fileSet);
  const sourceByFile = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
  const parsedByFile = new Map();
  const errors = [];
  const advisories = [];
  const referencesByFile = new Map();
  const exportEdges = new Map();
  const consumers = new Map();
  const retiredReferencesByFile = new Map();

  for (const file of files) {
    const sourceFile = parseSource(file, sourceByFile.get(file));
    parsedByFile.set(file, sourceFile);
    const references = moduleReferences(sourceFile).map((reference) => ({
      ...reference,
      target: reference.specifier === null
        ? null
        : resolveModule(file, reference.specifier, fileSet, policy.entry_exports)
    }));
    referencesByFile.set(file, references);
    for (const reference of references) {
      if (reference.target !== null) addToSet(consumers, reference.target, file);
      if (reference.isExport && reference.target !== null) {
        addToSet(exportEdges, file, reference.target);
      }
    }
  }
  for (const file of allSourceFiles) {
    const sourceFile = parsedByFile.get(file) ?? parseSource(
      file,
      readFileSync(path.join(root, file), "utf8")
    );
    retiredReferencesByFile.set(file, moduleReferences(sourceFile));
  }

  checkFileAndFunctionSize({ files, policy, sourceByFile, parsedByFile, errors, advisories });
  checkDirectories({ files, policy, errors, advisories });
  checkWorkspaceInventory({ root, policy, errors });
  checkDependencyDirection({ files, policy, referencesByFile, errors });
  checkArtifactReferences({ files, policy, parsedByFile, sourceByFile, errors, advisories });
  checkNonLiteralModuleSpecifiers({ files, policy, referencesByFile, errors, advisories });
  checkRetiredPaths({ files: allSourceFiles, policy, referencesByFile: retiredReferencesByFile, errors });
  checkEntryExports({ policy, parsedByFile, fileSet, sourceByFile, errors });
  checkBarrels({
    files,
    policy,
    exportEdges,
    consumers,
    parsedByFile,
    fileSet,
    sourceByFile,
    referencesByFile,
    errors,
    advisories
  });

  return {
    errors: sortIssues(errors),
    advisories: sortIssues(advisories),
    summary: {
      files: files.length,
      errors: errors.length,
      advisories: advisories.length
    }
  };
}

export function computeEntryExportSnapshots({ root, policy }) {
  validatePolicy(policy);
  const files = listGuardFiles(root);
  const fileSet = new Set(files);
  validateEntryExportPaths(policy, fileSet);
  const sourceByFile = new Map(files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]));
  const parsedByFile = new Map(
    files.map((file) => [file, parseSource(file, sourceByFile.get(file))])
  );
  return policy.entry_exports.map((entry) => {
    const bindings = collectExportedBindings(entry.path, {
      policy,
      fileSet,
      parsedByFile,
      sourceByFile,
      cache: new Map(),
      visiting: new Set()
    });
    return {
      specifier: entry.specifier,
      path: entry.path,
      expected_count: bindings.size,
      expected_sha256: hashExportBindings(bindings)
    };
  });
}

export function computePrivateBarrelSnapshots({ root, policy }) {
  validatePolicy(policy);
  const files = listGuardFiles(root);
  const fileSet = new Set(files);
  const entryPaths = new Set(policy.entry_exports.map((entry) => entry.path));
  const consumers = new Map();
  for (const file of files) {
    const sourceFile = parseSource(file, readFileSync(path.join(root, file), "utf8"));
    for (const reference of moduleReferences(sourceFile)) {
      if (reference.specifier === null) continue;
      const target = resolveModule(file, reference.specifier, fileSet, policy.entry_exports);
      if (target !== null) addToSet(consumers, target, file);
    }
  }
  const barrels = files
    .filter((file) => isBarrelFile(file) && !entryPaths.has(file))
    .map((file) => ({
      path: file,
      consumers: [...(consumers.get(file) ?? [])].sort(compareText)
    }))
    .sort((left, right) => compareText(left.path, right.path));
  return {
    expected_count: barrels.length,
    expected_sha256: hashPrivateBarrelRows(barrels),
    barrels
  };
}

export function formatIssue(issue) {
  return [
    `[${issue.severity}] ${issue.rule}`,
    `path=${issue.path}`,
    `observed=${issue.observed}`,
    `next=${issue.nextAction}`
  ].join(" | ");
}

function checkFileAndFunctionSize(context) {
  const { files, policy, sourceByFile, parsedByFile, errors, advisories } = context;
  for (const file of files) {
    const classification = policy.file_size.classifications[file] ?? {
      kind: "handwritten",
      reason: "handwritten production source"
    };
    const source = sourceByFile.get(file);
    const lines = lineCount(source);
    if (lines >= policy.file_size.fail_at && classification.kind === "handwritten") {
      errors.push(issue(
        "error",
        "source-file-size-hard-limit",
        file,
        `${lines} lines; class=${classification.kind}; fail_at=${policy.file_size.fail_at}`,
        "Split at a domain, phase, side-effect, or reuse boundary before adding behavior."
      ));
    } else if (lines >= policy.file_size.review_at) {
      advisories.push(issue(
        "advisory",
        "source-file-size-review",
        file,
        `${lines} lines; class=${classification.kind}; reason=${classification.reason}`,
        classification.kind === "handwritten"
          ? "Review cohesion and record the reason to retain or the later-card split owner."
          : "Keep the explicit classification current; do not silently skip this file."
      ));
    }
    if (classification.kind !== "handwritten") continue;
    for (const functionInfo of functionSpans(parsedByFile.get(file))) {
      if (functionInfo.lines < policy.function_size.review_at) continue;
      const splitReview = functionInfo.lines >= policy.function_size.split_review_at;
      advisories.push(issue(
        "advisory",
        splitReview ? "function-size-split-review" : "function-size-cohesion-review",
        `${file}:${functionInfo.startLine}`,
        `${functionInfo.lines} lines; function=${functionInfo.name}`,
        splitReview
          ? "Split before extension when decisions or effects are mixed; retain only with a named cohesion reason."
          : "Review phase and branch cohesion; do not extract a one-use wrapper merely to reduce lines."
      ));
    }
  }
}

function checkDirectories({ files, policy, errors, advisories }) {
  const directoryFiles = new Map();
  for (const file of files) addToSet(directoryFiles, path.posix.dirname(file), file);
  const forbidden = new Set(policy.forbidden_ownership_directories);
  const exceptionEntries = new Map(
    Object.entries(policy.existing_ownership_directory_exceptions ?? {})
      .map(([directory, entries]) => [directory, new Set(entries)])
  );
  const rolloutPatterns = policy.forbidden_rollout_directory_patterns.map(
    (pattern) => new RegExp(pattern, "u")
  );

  for (const [directory, members] of directoryFiles) {
    if (members.size >= policy.directory_size.advisory_at) {
      advisories.push(issue(
        "advisory",
        "directory-sibling-navigation-review",
        directory,
        `${members.size} direct source siblings; advisory_at=${policy.directory_size.advisory_at}`,
        "Keep the directory when cohesion is named; otherwise split only at a real domain or phase boundary."
      ));
    }
    const segments = directory.split("/");
    const forbiddenSegment = segments.find((segment) => forbidden.has(segment));
    if (forbiddenSegment !== undefined) {
      const allowedFiles = exceptionEntries.get(directory);
      const newFiles = [...members].filter((file) => !allowedFiles?.has(file));
      if (allowedFiles === undefined || newFiles.length > 0) {
        errors.push(issue(
          "error",
          "forbidden-generic-ownership-directory",
          directory,
          `segment=${forbiddenSegment}; new_files=${newFiles.join(",") || "all"}`,
          "Move each module to a named domain or phase owner; existing exceptions are shrink-only."
        ));
      } else {
        advisories.push(issue(
          "advisory",
          "generic-ownership-exception",
          directory,
          `${members.size} baseline files; shrink-only`,
          "Do not add files; rehome a module under its named owner when it is next touched."
        ));
      }
    }
    const rolloutSegment = segments.find((segment) =>
      rolloutPatterns.some((pattern) => pattern.test(segment))
    );
    if (rolloutSegment !== undefined) {
      errors.push(issue(
        "error",
        "forbidden-rollout-ownership-directory",
        directory,
        `segment=${rolloutSegment}`,
        "Use stable domain vocabulary; keep version/card/band identity in contracts or receipts, not ownership paths."
      ));
    }
  }
  for (const [directory, allowedFiles] of exceptionEntries) {
    const members = directoryFiles.get(directory) ?? new Set();
    const staleFiles = [...allowedFiles].filter((file) => !members.has(file));
    if (staleFiles.length === 0) continue;
    errors.push(issue(
      "error",
      "stale-generic-ownership-exception",
      directory,
      `removed_files=${staleFiles.join(",")}`,
      "Remove retired exception entries with the same change so an old generic path cannot return."
    ));
  }
}

function checkDependencyDirection({ files, policy, referencesByFile, errors }) {
  const workspaces = [...policy.workspaces].sort(
    (left, right) => right.root.length - left.root.length || compareText(left.root, right.root)
  );
  const packageNames = workspaces.map((workspace) => workspace.package)
    .sort((left, right) => right.length - left.length || compareText(left, right));
  for (const file of files) {
    const sourceWorkspace = workspaces.find((workspace) => isUnderRoot(file, workspace.root));
    if (sourceWorkspace === undefined) {
      errors.push(issue(
        "error",
        "unscoped-workspace-source",
        file,
        "file is outside every policy.workspaces root",
        "Add the owning workspace to policy.workspaces or move the file under an owned package."
      ));
      continue;
    }
    const allowed = new Set(sourceWorkspace.allowed_workspace_packages);
    for (const reference of referencesByFile.get(file) ?? []) {
      if (reference.specifier === null) continue;
      const referencedPackage = packageNames.find((packageName) =>
        reference.specifier === packageName || reference.specifier.startsWith(`${packageName}/`)
      );
      const targetWorkspace = reference.target === null
        ? undefined
        : workspaces.find((workspace) => isUnderRoot(reference.target, workspace.root));
      const targetPackage = referencedPackage ?? targetWorkspace?.package;
      if (targetPackage === undefined || targetPackage === sourceWorkspace.package) continue;
      if (allowed.has(targetPackage)) continue;
      errors.push(issue(
        "error",
        "workspace-dependency-direction",
        file,
        `${sourceWorkspace.package} -> ${targetPackage} via ${reference.specifier}`,
        "Depend on the declared lower-level contract or move composition to an app boundary."
      ));
    }
  }
}

function checkArtifactReferences({ files, policy, parsedByFile, sourceByFile, errors, advisories }) {
  const runtimeRoots = policy.runtime_artifact_roots;
  const exemptRoots = policy.artifact_scan_exempt_roots;
  for (const file of files) {
    const inRuntime = runtimeRoots.some((root) => isUnderRoot(file, root));
    const inExempt = exemptRoots.some((root) => isUnderRoot(file, root));
    if (!inRuntime && !inExempt) {
      errors.push(issue(
        "error",
        "unscoped-artifact-jurisdiction",
        file,
        "file is outside runtime_artifact_roots and artifact_scan_exempt_roots",
        "Add the owning src root to runtime_artifact_roots or the named exempt list."
      ));
    }
    if (!inRuntime) continue;
    const occurrencesByFragment = countArtifactReferences(
      parsedByFile.get(file),
      policy.artifact_reference_fragments
    );
    const occurrences = Object.values(occurrencesByFragment).reduce((total, count) => total + count, 0);
    const exception = policy.existing_artifact_reference_exceptions[file];
    if (occurrences === 0 && exception === undefined) continue;
    const exceededFragments = policy.artifact_reference_fragments.filter(
      (fragment) =>
        occurrencesByFragment[fragment] > (exception?.max_occurrences_by_fragment[fragment] ?? 0)
    );
    const staleFragments = exception === undefined
      ? []
      : policy.artifact_reference_fragments.filter(
        (fragment) => occurrencesByFragment[fragment] < exception.max_occurrences_by_fragment[fragment]
      );
    const observed = policy.artifact_reference_fragments
      .map((fragment) =>
        `${fragment}=${occurrencesByFragment[fragment]}/${exception?.max_occurrences_by_fragment[fragment] ?? 0}`
      )
      .join(",");
    if (exception === undefined || exceededFragments.length > 0) {
      errors.push(issue(
        "error",
        "production-artifact-reference",
        file,
        `${observed}; exceeded=${exceededFragments.join(",") || "all"}`,
        "Use a production-owned port/store; do not make runtime truth depend on scratch or benchmark evidence."
      ));
    } else if (staleFragments.length > 0) {
      errors.push(issue(
        "error",
        "stale-production-artifact-exception",
        file,
        `${observed}; stale=${staleFragments.join(",")}`,
        "Lower or remove the exception with the same change so removed runtime evidence debt cannot return."
      ));
    } else {
      advisories.push(issue(
        "advisory",
        "production-artifact-reference-exception",
        file,
        `${observed}; ${exception.reason}`,
        "This exception is shrink-only and requires the named authority decision before relocation or expansion."
      ));
    }
  }
  for (const file of Object.keys(policy.existing_artifact_reference_exceptions)) {
    if (sourceByFile.has(file)) continue;
    errors.push(issue(
      "error",
      "stale-production-artifact-exception",
      file,
      "exception file is absent from the guarded production source set",
      "Remove the exception with the same change so the retired artifact dependency cannot return."
    ));
  }
}

function checkRetiredPaths({ files, policy, referencesByFile, errors }) {
  for (const file of files) {
    const recreatedPath = policy.retired_import_paths.find((retiredPath) =>
      sourcePathMatchesRetiredPath(file, retiredPath)
    );
    if (recreatedPath !== undefined) {
      errors.push(issue(
        "error",
        "retired-source-path-restored",
        file,
        `retired=${recreatedPath}`,
        "Delete the restored path and keep imports on the accepted current owner."
      ));
    }
    for (const reference of referencesByFile.get(file) ?? []) {
      if (reference.specifier === null) continue;
      const normalized = unresolvedModulePath(file, reference.specifier, policy.entry_exports);
      const retired = policy.retired_import_paths.find((retiredPath) =>
        normalized === retiredPath || normalized.startsWith(`${retiredPath}/`)
      );
      if (retired === undefined) continue;
      errors.push(issue(
        "error",
        "retired-import-path",
        file,
        `specifier=${reference.specifier}; retired=${retired}`,
        "Import the accepted current owner; do not restore a compatibility alias for an internal retired path."
      ));
    }
  }
}

function checkEntryExports({ policy, parsedByFile, fileSet, sourceByFile, errors }) {
  for (const entry of policy.entry_exports) {
    const bindings = collectExportedBindings(entry.path, {
      policy,
      fileSet,
      parsedByFile,
      sourceByFile,
      cache: new Map(),
      visiting: new Set()
    });
    const digest = hashExportBindings(bindings);
    if (bindings.size === entry.expected_count && digest === entry.expected_sha256) continue;
    errors.push(issue(
      "error",
      "workspace-entry-export-drift",
      entry.path,
      `specifier=${entry.specifier}; count=${bindings.size}/${entry.expected_count}; sha256=${digest}/${entry.expected_sha256}`,
      "Restore the accepted binding set or obtain S08/SemVer authority and update the reviewed snapshot."
    ));
  }
}

function checkBarrels(context) {
  const barrels = new Set(context.files.filter(isBarrelFile));
  const entryPaths = new Set(context.policy.entry_exports.map((entry) => entry.path));
  checkPrivateBarrelSnapshot(context, barrels, entryPaths);
  checkBarrelChains(context, barrels);
  checkBarrelCycles(context, barrels);
  checkDuplicateExportAuthorities(context, barrels, entryPaths);
}

function checkPrivateBarrelSnapshot({ policy, consumers, errors }, barrels, entryPaths) {
  const privateBarrelRows = [...barrels]
    .filter((file) => !entryPaths.has(file))
    .sort(compareText)
    .map((barrel) => ({
      path: barrel,
      consumers: [...(consumers.get(barrel) ?? [])].sort(compareText)
    }));
  const privateBarrelDigest = hashPrivateBarrelRows(privateBarrelRows);
  if (
    privateBarrelRows.length === policy.private_barrel_snapshot.expected_count &&
    privateBarrelDigest === policy.private_barrel_snapshot.expected_sha256
  ) {
    return;
  }
  errors.push(issue(
    "error",
    "private-barrel-snapshot-drift",
    "scripts/ci/repository-structure-policy.json",
    `count=${privateBarrelRows.length}/${policy.private_barrel_snapshot.expected_count}; ` +
    `sha256=${privateBarrelDigest}/${policy.private_barrel_snapshot.expected_sha256}`,
    "Review new or removed barrels and exact consumer identities; import real owners or update the accepted snapshot."
  ));
}

function checkBarrelChains({ policy, exportEdges, consumers, errors }, barrels) {
  const existingEdges = new Set(policy.existing_index_to_index_edges);
  const observedEdges = new Set();
  for (const source of barrels) {
    for (const target of exportEdges.get(source) ?? []) {
      if (!barrels.has(target)) continue;
      const edge = `${source} -> ${target}`;
      observedEdges.add(edge);
      if (existingEdges.has(edge)) continue;
      errors.push(issue(
        "error",
        "new-private-barrel-chain",
        source,
        `edge=${edge}; direct_consumers=${[...(consumers.get(source) ?? [])].length}`,
        "Export from the real owner or record a reviewed public entry; do not add a private pass-through chain."
      ));
    }
  }
  for (const staleEdge of [...existingEdges].filter((edge) => !observedEdges.has(edge))) {
    errors.push(issue(
      "error",
      "stale-private-barrel-edge-exception",
      staleEdge.split(" -> ")[0],
      `removed_edge=${staleEdge}`,
      "Remove the accepted-edge entry with the same change so the private chain cannot return silently."
    ));
  }
}

function checkBarrelCycles({ referencesByFile, errors }, barrels) {
  const graph = new Map([...barrels].map((file) => [file, new Set()]));
  for (const source of barrels) {
    for (const reference of referencesByFile.get(source) ?? []) {
      if (reference.target === null || !barrels.has(reference.target)) continue;
      graph.get(source).add(reference.target);
    }
  }
  for (const component of stronglyConnectedComponents(graph).filter((entry) => entry.length > 1)) {
    errors.push(issue(
      "error",
      "barrel-cycle",
      component[0],
      `SCC=${component.join(" -> ")}`,
      "Break the cycle by importing the real owner and preserving one direction of authority."
    ));
  }
}

function checkDuplicateExportAuthorities(context, barrels, entryPaths) {
  const { policy, parsedByFile, fileSet, sourceByFile, errors, advisories } = context;
  const duplicateReviewPaths = new Set([...barrels, ...entryPaths]);
  const expectedDuplicates = new Set(
    policy.existing_duplicate_export_authorities.map(duplicateAuthorityKey)
  );
  const observedDuplicates = new Set();
  for (const file of duplicateReviewPaths) {
    const duplicates = duplicateExportAuthorities(file, {
      policy,
      fileSet,
      parsedByFile,
      sourceByFile,
      cache: new Map(),
      visiting: new Set()
    });
    for (const duplicate of duplicates) {
      const duplicateRecord = { path: file, binding: duplicate.name, sources: duplicate.sources };
      const key = duplicateAuthorityKey(duplicateRecord);
      observedDuplicates.add(key);
      const target = expectedDuplicates.has(key) ? advisories : errors;
      target.push(issue(
        expectedDuplicates.has(key) ? "advisory" : "error",
        expectedDuplicates.has(key)
          ? "duplicate-export-authority-exception"
          : "duplicate-export-authority",
        file,
        `binding=${duplicate.name}; sources=${duplicate.sources.join(",")}`,
        expectedDuplicates.has(key)
          ? "This exact duplicate is shrink-only; select one real owner when the surface is next authorized."
          : "Select one real owner or add an explicit named re-export that resolves the authority."
      ));
    }
  }
  for (const key of [...expectedDuplicates].filter((entry) => !observedDuplicates.has(entry))) {
    errors.push(issue(
      "error",
      "stale-duplicate-export-authority-exception",
      key.split("\0")[0],
      `removed_duplicate=${key.replaceAll("\0", " | ")}`,
      "Remove the exception with the same change so the duplicate authority cannot return."
    ));
  }
}

function checkNonLiteralModuleSpecifiers({ files, policy, referencesByFile, errors, advisories }) {
  const exceptions = new Map(
    policy.existing_non_literal_module_specifier_exceptions.map((entry) => [entry.path, entry])
  );
  const observed = new Set();
  for (const file of files) {
    if (!(referencesByFile.get(file) ?? []).some((reference) => reference.dynamic === true)) continue;
    observed.add(file);
    const exception = exceptions.get(file);
    if (exception === undefined) {
      errors.push(issue(
        "error",
        "non-literal-module-specifier",
        file,
        "import() or require() argument is not a string literal",
        "Use a static specifier or record a shrink-only exact-file exception with a reason."
      ));
      continue;
    }
    advisories.push(issue(
      "advisory",
      "non-literal-module-specifier-exception",
      file,
      exception.reason,
      "This exception is shrink-only; replace the dynamic specifier with a static owner when the loader is next authorized."
    ));
  }
  for (const [file] of exceptions) {
    if (observed.has(file)) continue;
    errors.push(issue(
      "error",
      "stale-non-literal-module-specifier-exception",
      file,
      "exception file has no non-literal import() or require()",
      "Remove the exception with the same change so a dynamic specifier cannot return."
    ));
  }
}

function checkWorkspaceInventory({ root, policy, errors }) {
  const allowed = new Set(policy.workspaces.map((workspace) => workspace.package));
  for (const directory of discoverWorkspaceDirectories(root)) {
    const packageName = readWorkspacePackageName(directory);
    if (packageName === undefined) continue;
    if (packageName.length > 0 && allowed.has(packageName)) continue;
    errors.push(issue(
      "error",
      "workspace-inventory-drift",
      toPosixRelative(root, directory),
      packageName.length > 0 ? `package=${packageName}` : "package.json name is missing",
      "Add the package to policy.workspaces or remove the unexpected workspace."
    ));
  }
}

function discoverWorkspaceDirectories(root) {
  const directories = [];
  for (const globRoot of ["packages", "apps", "apps/inspector"]) {
    const topDirectory = path.join(root, globRoot);
    if (!existsSync(topDirectory)) continue;
    directories.push(...listImmediateDirectories(topDirectory));
  }
  return directories;
}

function listImmediateDirectories(directory) {
  const skipped = new Set(["node_modules", "dist", "data", "var", "coverage"]);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skipped.has(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function readWorkspacePackageName(directory) {
  const filename = path.join(directory, "package.json");
  if (!existsSync(filename)) return undefined;
  const parsed = JSON.parse(readFileSync(filename, "utf8"));
  return typeof parsed.name === "string" ? parsed.name : "";
}

function isBarrelFile(file) {
  const basename = path.posix.basename(file);
  return basename === "index.ts" || basename === "index.tsx";
}

function isUnderRoot(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

function toPosixRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function hashPrivateBarrelRows(rows) {
  return hashTextLines(rows.map((row) => `${row.path}\0${row.consumers.join("\0")}`));
}

function issue(severity, rule, issuePath, observed, nextAction) {
  return { severity, rule, path: issuePath, observed, nextAction };
}

function sortIssues(issues) {
  return issues.sort((left, right) =>
    compareText(
      `${left.severity}\0${left.rule}\0${left.path}\0${left.observed}`,
      `${right.severity}\0${right.rule}\0${right.path}\0${right.observed}`
    )
  );
}
