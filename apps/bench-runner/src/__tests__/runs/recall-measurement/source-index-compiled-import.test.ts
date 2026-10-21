import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const boundary = new URL("../../support/provider-free-boundary.ts", import.meta.url).href;
const binding = new URL("../../../../dist/runs/recall-measurement/source-index-binding.js", import.meta.url).href;
const contract = new URL("../../../../dist/runs/recall-measurement/contract.js", import.meta.url).href;

function importCompiled(first: string, second: string) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const { installProviderFreeBoundary } = await import(${JSON.stringify(boundary)});
    const isolation = installProviderFreeBoundary();
    const first = await import(${JSON.stringify(first)});
    const second = await import(${JSON.stringify(second)});
    const bindingModule = "prepareSemanticChainSourceIndex" in first ? first : second;
    const contractModule = "SemanticChainConfigSchema" in first ? first : second;
    if (typeof bindingModule.prepareSemanticChainSourceIndex !== "function") {
      throw new Error("binding execution export missing");
    }
    if (typeof bindingModule.inspectSemanticChainSourceIndex !== "function") {
      throw new Error("binding inspection export missing");
    }
    if (typeof contractModule.SemanticChainConfigSchema?.parse !== "function") {
      throw new Error("contract schema export missing");
    }
    if (typeof contractModule.assertChainSnapshot !== "function") {
      throw new Error("contract snapshot export missing");
    }
    if (isolation.violations.length !== 0) throw new Error("provider-free violations");
    console.log("COMPILED_IMPORT_OK");
  `], { env, encoding: "utf8", timeout: 30_000 });
}

it.each([
  ["source-index-binding then contract", binding, contract],
  ["contract then source-index-binding", contract, binding]
] as const)("initializes compiled recall-measurement modules in Node as %s without model work", (_order, first, second) => {
  const result = importCompiled(first, second);
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("COMPILED_IMPORT_OK");
  expect(result.stderr).not.toMatch(/before initialization/u);
});
