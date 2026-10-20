import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { runSourceRecall, sourceRecallPhaseAllowance } from "../../../runtime/recall-read-worker/source-recall.js";
import { sourceRecallPageAt } from "../../../runtime/recall-read-worker/source-recall-delivery.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const neutralModules = [
  "packages/core/dist/recall/runtime/source-recall-access.d.ts",
  "packages/core/dist/recall/runtime/source-recall-selection.d.ts",
  ...["source-recall", "source-recall-access", "source-recall-catalog", "source-recall-source-text",
    "source-recall-delivery", "source-recall-package-pairs"].map(name => `apps/core-daemon/dist/runtime/recall-read-worker/${name}.d.ts`)
].map(path => resolve(root, path));
const forbidden = new Set(["SourceSemanticQuery", "SourceSemanticInterpretation", "SourceSemanticCorrespondence",
  "SourceSemanticLibraryProof", "SourceSemanticLibraryPackage", "LibraryDeliveryPlan", "LibraryExecutedSupport",
  "SourceSemanticWorkerRequest", "SourceSemanticWorkerResult", "SourceSemanticWorkerPayload", "SourceSemanticAccessPool"]);

describe("neutral source recall ownership", () => {
  it("has no query, interpretation, correspondence or proof payload in its emitted type closure", () => {
    const adapterPath = resolve(root, "apps/core-daemon/dist/runtime/recall-read-worker/source-semantic-library-delivery.d.ts");
    const program = ts.createProgram([...neutralModules, adapterPath], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2023, skipLibCheck: true });
    const checker = program.getTypeChecker(), symbols = new Set<ts.Symbol>(), nodes = new Set<ts.Node>();
    const violations = new Set<string>();
    const inspect = (original: ts.Symbol): void => {
      const symbol = original.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(original) : original;
      if (symbols.has(symbol)) return;
      symbols.add(symbol);
      if (forbidden.has(symbol.name)) { violations.add(symbol.name); return; }
      for (const declaration of symbol.declarations ?? []) {
        const owner = relative(root, declaration.getSourceFile().fileName).split(sep)[0];
        if (owner === "packages" || owner === "apps") visit(declaration);
      }
    };
    const visit = (node: ts.Node): void => {
      if (nodes.has(node)) return;
      nodes.add(node);
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined) inspect(symbol);
      }
      ts.forEachChild(node, visit);
    };
    // Inspect declaration references rather than erased z.infer aliases. This also
    // follows Pick, ReturnType, generic arguments and non-exported adapter aliases.
    const protocol = program.getSourceFile(resolve(root, "packages/protocol/dist/index.d.ts"));
    expect(protocol).toBeDefined();
    const protocolModule = checker.getSymbolAtLocation(protocol!);
    const queryExport = checker.getExportsOfModule(protocolModule!).find(symbol => symbol.name === "SourceSemanticQuery");
    expect(queryExport).toBeDefined();
    inspect(queryExport!);
    expect([...violations]).toContain("SourceSemanticQuery");
    symbols.clear(); nodes.clear(); violations.clear();
    // This non-forbidden export must expose its nested payload types on every OS.
    const adapter = program.getSourceFile(adapterPath);
    expect(adapter).toBeDefined();
    const adapterSymbol = checker.getSymbolAtLocation(adapter!);
    expect(adapterSymbol).toBeDefined();
    const prepare = checker.getExportsOfModule(adapterSymbol!).find(symbol => symbol.name === "prepareLibraryDelivery");
    expect(prepare).toBeDefined();
    inspect(prepare!);
    expect([...violations]).toContain("SourceSemanticLibraryPackage");
    symbols.clear(); nodes.clear(); violations.clear();
    for (const path of neutralModules) {
      const source = program.getSourceFile(path);
      expect(source, path).toBeDefined();
      const module = source === undefined ? undefined : checker.getSymbolAtLocation(source);
      expect(module, path).toBeDefined();
      for (const exported of checker.getExportsOfModule(module!)) inspect(exported);
    }
    expect([...violations]).toEqual([]);
  }, 30_000); // TypeScript declaration loading is structural analysis, not a 5-second runtime operation.

  it("keeps observation before optional computation and absorbs exploration before finalization", () => {
    const meter = new SourceSemanticResourceLedger({ work_units: 101, memory_bytes: 1001 });
    const events: string[] = [];
    runSourceRecall(meter, 30, 50, {
      observe: allowance => { expect(allowance).toEqual({ work_units: 76, memory_bytes: 751 }); events.push("observe"); },
      compute: () => { events.push("compute"); }, absorbExploration: () => { events.push("absorb"); },
      finalize: () => { events.push("finalize"); }, deliver: () => { events.push("deliver"); }
    });
    expect(events).toEqual(["observe", "compute", "absorb", "finalize", "deliver"]);
    expect(sourceRecallPhaseAllowance(meter, "observation")).toEqual({ work_units: 50, memory_bytes: 500 });
    expect(sourceRecallPhaseAllowance(meter, "package_hydration")).toEqual({ work_units: 33, memory_bytes: 333 });
    expect(sourceRecallPhaseAllowance(meter, "selection")).toEqual({ work_units: 50, memory_bytes: 500 });
  });

  it.each(["observe", "compute", "finalize", "deliver"])("absorbs once when %s fails", failure => {
    const events: string[] = [], expected = new Error(failure);
    const step = (name: string) => { events.push(name); if (failure === name) throw expected; };
    expect(() => runSourceRecall(new SourceSemanticResourceLedger({ work_units: 100, memory_bytes: 1000 }), 10, 10, {
      observe: () => step("observe"), compute: () => step("compute"), absorbExploration: () => step("absorb"),
      finalize: () => step("finalize"), deliver: () => step("deliver")
    })).toThrow(expected);
    expect(events.filter(name => name === "absorb")).toHaveLength(1);
    expect(events.includes("deliver")).toBe(failure === "deliver");
  });

  it("accepts only frozen page boundaries without discovery or materialization", () => {
    const lengths = [5, 2, 1];
    expect(sourceRecallPageAt(lengths.length, index => lengths[index]!, 0)).toBe(0);
    expect(sourceRecallPageAt(lengths.length, index => lengths[index]!, 5)).toBe(1);
    expect(sourceRecallPageAt(lengths.length, index => lengths[index]!, 7)).toBe(2);
    expect(() => sourceRecallPageAt(lengths.length, index => lengths[index]!, 6)).toThrow("not a frozen page boundary");
  });
});
