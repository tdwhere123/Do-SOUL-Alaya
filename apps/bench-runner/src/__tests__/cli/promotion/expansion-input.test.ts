import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyLongMemEvalExpansionContractInput,
  type LongMemEvalExpansionContractInputDependencies
} from "../../../cli/promotion/expansion-input.js";

describe("LongMemEval expansion contract CLI input", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("descriptor-reads the original promotion contract and invokes live verification", async () => {
    root = await mkdtemp(join(tmpdir(), "expansion-contract-input-"));
    const contractPath = join(root, "matrix.json");
    await writeFile(contractPath, "matrix-contract", "utf8");
    const capability = Object.freeze({});
    const verify = vi.fn(async () => capability as never);
    const dependencies: LongMemEvalExpansionContractInputDependencies = {
      checkoutRoot: "/repo",
      verify
    };

    expect(await verifyLongMemEvalExpansionContractInput(
      contractPath,
      dependencies
    )).toBe(capability);
    expect(verify).toHaveBeenCalledWith({
      checkoutRoot: "/repo",
      contractPath: resolve(contractPath),
      contractRoot: root,
      contractContents: Buffer.from("matrix-contract", "utf8")
    });
  });
});
