import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

const TYPE_BINDING = 1;
const VALUE_BINDING = 2;
const BOTH_BINDING = TYPE_BINDING | VALUE_BINDING;
const UNKNOWN_BINDING = 4;

export function listGuardFiles(root) {
  return listSourceFiles(root, false);
}

export function listSourceFiles(root, includeTests) {
  const fromRipgrep = tryListSourceFiles(() => listSourceFilesWithRipgrep(root, includeTests));
  const fromGit = tryListSourceFiles(() => listSourceFilesWithGit(root, includeTests));
  if (fromRipgrep === null && fromGit === null) {
    throw new Error("repository-structure: ripgrep and git are both unavailable");
  }
  return [...new Set([...(fromRipgrep ?? []), ...(fromGit ?? [])])].sort(compareText);
}

function tryListSourceFiles(list) {
  try {
    return list();
  } catch (error) {
    if (isListingUnavailable(error)) return null;
    throw error;
  }
}

function isListingUnavailable(error) {
  if (error?.code === "ENOENT") return true;
  const detail = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  return /not a git repository/iu.test(detail);
}

function listSourceFilesWithRipgrep(root, includeTests) {
  const patterns = [
    "--files",
    "-g", "**/src/**/*.ts",
    "-g", "**/src/**/*.tsx",
    "-g", "!**/dist/**",
    "-g", "!**/node_modules/**"
  ];
  if (!includeTests) {
    patterns.push(
      "-g", "!**/__tests__/**",
      "-g", "!**/*.{test,spec}.ts",
      "-g", "!**/*.{test,spec}.tsx"
    );
  }
  return execFileSync("rg", patterns, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .trim()
    .split("\n")
    .filter((file) => file.length > 0 && isGuardedSourcePath(file, includeTests))
    .sort(compareText);
}

function listSourceFilesWithGit(root, includeTests) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  )
    .split("\0")
    .filter((file) => file.length > 0 && isGuardedSourcePath(file, includeTests))
    .sort(compareText);
}

function isGuardedSourcePath(relativePath, includeTests) {
  const file = relativePath.replaceAll("\\", "/");
  if (
    file === "dist" ||
    file.startsWith("dist/") ||
    file.includes("/dist/") ||
    file === "node_modules" ||
    file.startsWith("node_modules/") ||
    file.includes("/node_modules/")
  ) {
    return false;
  }
  if (!/(?:^|\/)src\/.+\.tsx?$/u.test(file)) return false;
  if (!includeTests) {
    if (file.includes("/__tests__/")) return false;
    if (/\.(?:test|spec)\.tsx?$/u.test(file)) return false;
  }
  return true;
}

export function parseSource(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

export function moduleReferences(sourceFile) {
  const references = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        references.push({
          specifier: node.moduleSpecifier.text,
          dynamic: false,
          isExport: ts.isExportDeclaration(node)
        });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression) {
        if (ts.isStringLiteralLike(reference.expression)) {
          references.push({ specifier: reference.expression.text, dynamic: false, isExport: false });
        } else {
          references.push({ specifier: null, dynamic: true, isExport: false });
        }
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          references.push({ specifier: argument.text, dynamic: false, isExport: false });
        } else {
          references.push({ specifier: null, dynamic: true, isExport: false });
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        references.push({ specifier: argument.literal.text, dynamic: false, isExport: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

export function countArtifactReferences(sourceFile, fragments) {
  const counts = Object.fromEntries(fragments.map((fragment) => [fragment, 0]));
  for (const candidate of staticTextCandidates(sourceFile)) {
    for (const fragment of fragments) counts[fragment] += countOccurrences(candidate, fragment);
  }
  return counts;
}

function staticTextCandidates(sourceFile) {
  const candidates = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isPathCompositionCall(node.expression)) {
      const parts = node.arguments.map(staticText);
      if (parts.some((part) => part !== null)) {
        candidates.push(parts.map((part) => part ?? "\0").join("/"));
      }
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const text = staticText(node);
      if (text !== null) {
        candidates.push(text);
        return;
      }
    }
    if (ts.isTemplateExpression(node)) {
      candidates.push(
        node.head.text + node.templateSpans
          .map((span) => `${staticText(span.expression) ?? "\0"}${span.literal.text}`)
          .join("")
      );
      for (const span of node.templateSpans) ts.forEachChild(span.expression, visit);
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      candidates.push(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function staticText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    const spans = node.templateSpans.map((span) => {
      const expression = staticText(span.expression);
      return expression === null ? null : `${expression}${span.literal.text}`;
    });
    return spans.some((span) => span === null)
      ? null
      : `${node.head.text}${spans.join("")}`;
  }
  return null;
}

function isPathCompositionCall(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "join" || expression.text === "resolve";
  return ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "join" || expression.name.text === "resolve");
}

export function collectExportedBindings(file, context) {
  if (context.cache.has(file)) return context.cache.get(file);
  if (context.visiting.has(file)) return new Map();
  const sourceFile = context.parsedByFile.get(file);
  if (sourceFile === undefined) return new Map();
  context.visiting.add(file);
  const bindings = new Map();
  const locals = collectLocalBindings(file, sourceFile, context);
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      collectExportDeclarationBindings(file, statement, context, locals, bindings);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      addBinding(bindings, "default", VALUE_BINDING);
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, (name) => addBinding(bindings, name, VALUE_BINDING));
      }
    } else if (hasDefaultModifier(statement)) {
      addBinding(bindings, "default", declarationBindingKind(statement));
    } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) {
      addBinding(bindings, statement.name.text, declarationBindingKind(statement));
    }
  }
  context.visiting.delete(file);
  context.cache.set(file, bindings);
  return bindings;
}

export function duplicateExportAuthorities(file, context) {
  const sourceFile = context.parsedByFile.get(file);
  if (sourceFile === undefined) return [];
  const sourcesByName = new Map();
  const explicitNames = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const target = specifier === null
      ? null
      : resolveModule(file, specifier, context.fileSet, context.policy.entry_exports);
    const source = target ?? specifier ?? file;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (explicitNames.has(element.name.text)) {
          addToSet(sourcesByName, element.name.text, source);
        } else {
          sourcesByName.set(element.name.text, new Set([source]));
          explicitNames.add(element.name.text);
        }
      }
    } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
      const name = statement.exportClause.name.text;
      if (explicitNames.has(name)) addToSet(sourcesByName, name, source);
      else {
        sourcesByName.set(name, new Set([source]));
        explicitNames.add(name);
      }
    } else if (target !== null) {
      const bindings = collectExportedBindings(target, context);
      for (const name of bindings.keys()) {
        if (name !== "default" && !explicitNames.has(name)) {
          addToSet(sourcesByName, name, source);
        }
      }
    } else if (specifier !== null) {
      addToSet(sourcesByName, `*:${specifier}`, source);
    }
  }
  return [...sourcesByName]
    .filter(([, sources]) => sources.size > 1)
    .map(([name, sources]) => ({ name, sources: [...sources].sort(compareText) }))
    .sort((left, right) => compareText(left.name, right.name));
}

function collectExportDeclarationBindings(file, statement, context, locals, bindings) {
  const target = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    ? resolveModule(file, statement.moduleSpecifier.text, context.fileSet, context.policy.entry_exports)
    : null;
  const targetBindings = target === null ? null : collectExportedBindings(target, context);
  if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) {
      const sourceName = (element.propertyName ?? element.name).text;
      const kind = statement.isTypeOnly || element.isTypeOnly
        ? TYPE_BINDING
        : targetBindings?.get(sourceName) ?? locals.get(sourceName) ?? UNKNOWN_BINDING;
      addBinding(bindings, element.name.text, kind);
    }
  } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
    addBinding(
      bindings,
      statement.exportClause.name.text,
      statement.isTypeOnly ? TYPE_BINDING : BOTH_BINDING
    );
  } else if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
    if (targetBindings !== null) {
      for (const [name, kind] of targetBindings) {
        if (name !== "default") {
          addBinding(bindings, name, statement.isTypeOnly ? TYPE_BINDING : kind);
        }
      }
    } else {
      addBinding(bindings, `*:${statement.moduleSpecifier.text}`, UNKNOWN_BINDING);
    }
  }
}

function collectLocalBindings(file, sourceFile, context) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, (name) => addBinding(bindings, name, VALUE_BINDING));
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      collectImportBindings(file, statement, context, bindings);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      addBinding(bindings, statement.name.text, statement.isTypeOnly ? TYPE_BINDING : UNKNOWN_BINDING);
    } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) {
      addBinding(bindings, statement.name.text, declarationBindingKind(statement));
    }
  }
  return bindings;
}

function collectImportBindings(file, declaration, context, bindings) {
  const importClause = declaration.importClause;
  const target = ts.isStringLiteralLike(declaration.moduleSpecifier)
    ? resolveModule(file, declaration.moduleSpecifier.text, context.fileSet, context.policy.entry_exports)
    : null;
  const targetBindings = target === null ? null : collectExportedBindings(target, context);
  const clauseKind = importClause.isTypeOnly ? TYPE_BINDING : UNKNOWN_BINDING;
  if (importClause.name) {
    addBinding(
      bindings,
      importClause.name.text,
      importClause.isTypeOnly ? TYPE_BINDING : targetBindings?.get("default") ?? clauseKind
    );
  }
  if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
    addBinding(
      bindings,
      importClause.namedBindings.name.text,
      importClause.isTypeOnly ? TYPE_BINDING : VALUE_BINDING
    );
  } else if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
    for (const element of importClause.namedBindings.elements) {
      const sourceName = (element.propertyName ?? element.name).text;
      addBinding(
        bindings,
        element.name.text,
        importClause.isTypeOnly || element.isTypeOnly
          ? TYPE_BINDING
          : targetBindings?.get(sourceName) ?? UNKNOWN_BINDING
      );
    }
  }
}

function declarationBindingKind(statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return TYPE_BINDING;
  }
  if (
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return BOTH_BINDING;
  }
  return VALUE_BINDING;
}

function addBinding(bindings, name, kind) {
  bindings.set(name, (bindings.get(name) ?? 0) | kind);
}

export function addToSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

export function resolveModule(sourceFile, specifier, fileSet, entryExports) {
  const entry = findEntryExport(specifier, entryExports);
  if (entry !== undefined) {
    if (specifier === entry.specifier) return entry.path;
    const suffix = specifier.slice(entry.specifier.length + 1);
    return resolveCandidate(path.posix.join(path.posix.dirname(entry.path), suffix), fileSet);
  }
  if (!specifier.startsWith(".")) return null;
  return resolveCandidate(
    path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier)),
    fileSet
  );
}

function resolveCandidate(base, fileSet) {
  const candidates = [];
  if (/\.(?:js|jsx|mjs|cjs)$/u.test(base)) {
    const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`);
  } else if (/\.(?:ts|tsx)$/u.test(base)) {
    candidates.push(base);
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.d.ts`,
      path.posix.join(base, "index.ts"),
      path.posix.join(base, "index.tsx")
    );
  }
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

export function unresolvedModulePath(sourceFile, specifier, entryExports) {
  const entry = findEntryExport(specifier, entryExports);
  const base = entry === undefined
    ? specifier.startsWith(".")
      ? path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier))
      : specifier
    : specifier === entry.specifier
      ? entry.path
      : path.posix.join(
        path.posix.dirname(entry.path),
        specifier.slice(entry.specifier.length + 1)
      );
  return base.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx)$/u, "").replace(/\/$/u, "");
}

function findEntryExport(specifier, entryExports) {
  return [...entryExports]
    .sort((left, right) => right.specifier.length - left.specifier.length)
    .find((candidate) =>
      specifier === candidate.specifier || specifier.startsWith(`${candidate.specifier}/`)
    );
}

export function sourcePathMatchesRetiredPath(file, retiredPath) {
  const stem = file.replace(/\.(?:d\.)?(?:ts|tsx)$/u, "");
  return stem === retiredPath || stem.startsWith(`${retiredPath}/`);
}

export function functionSpans(sourceFile) {
  const spans = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
      spans.push({
        startLine,
        lines: endLine - startLine + 1,
        name: functionName(node)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return spans;
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "<anonymous>";
}

function hasExportModifier(node) {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node) {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function collectBindingNames(name, addName) {
  if (ts.isIdentifier(name)) {
    addName(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, addName);
  }
}

export function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexByNode = new Map();
  const lowByNode = new Map();
  const components = [];
  const visit = (node) => {
    indexByNode.set(node, nextIndex);
    lowByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowByNode.set(node, Math.min(lowByNode.get(node), lowByNode.get(target)));
      } else if (onStack.has(target)) {
        lowByNode.set(node, Math.min(lowByNode.get(node), indexByNode.get(target)));
      }
    }
    if (lowByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort(compareText));
  };
  for (const node of [...graph.keys()].sort(compareText)) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components;
}

export function lineCount(source) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\n|\r/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function countOccurrences(source, fragment) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(fragment, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + fragment.length;
  }
}

export function hashExportBindings(bindings) {
  const lines = [...bindings]
    .map(([name, kind]) => `${bindingKindName(kind)}:${name}`)
    .sort(compareText);
  return hashTextLines(lines);
}

export function hashTextLines(lines) {
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

function bindingKindName(kind) {
  if ((kind & UNKNOWN_BINDING) !== 0) return "unknown";
  if (kind === BOTH_BINDING) return "both";
  if (kind === TYPE_BINDING) return "type";
  return "value";
}

export function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
