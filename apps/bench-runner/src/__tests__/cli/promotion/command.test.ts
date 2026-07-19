import { lstatSync } from "node:fs";
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runAuthorizeLongMemEvalMatrixCommand,
  type LongMemEvalMatrixPromotionCommandDependencies
} from "../../../cli/promotion/command.js";
import {
  LongMemEvalMatrixPromotionAuthorizationSchema,
  LongMemEvalMatrixPromotionRejectionSchema
} from
  "../../../longmemeval/promotion/schema/authorization.js";
import { promotionAuthorizationFixture } from "./authorization-fixture.js";
import { expansionPromotionContractFixture } from
  "../../longmemeval/expansion/expansion-promotion-contract-fixture.js";

describe("LongMemEval matrix promotion command", () => {
  let root: string;
  let contractPath: string;
  let outputPath: string;
  let contractBytes: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-promotion-command-"));
    contractPath = join(root, "matrix.json");
    outputPath = join(root, "authorization.json");
    contractBytes = `${JSON.stringify(expansionPromotionContractFixture())}\n`;
    await writeFile(contractPath, contractBytes, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads the contract by descriptor and publishes one schema-valid authorization", async () => {
    const authorize = vi.fn(async () => promotionAuthorizationFixture());
    const io = captureIo(authorize);

    expect(await runAuthorizeLongMemEvalMatrixCommand([
      "--contract", contractPath, "--out", outputPath
    ], io)).toBe(0);

    const written = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
    expect(LongMemEvalMatrixPromotionAuthorizationSchema.parse(written))
      .toEqual(promotionAuthorizationFixture());
    expect(authorize).toHaveBeenCalledWith({
      checkoutRoot: "/repo",
      contractPath,
      contractRoot: root,
      contractContents: Buffer.from(contractBytes, "utf8")
    });
    expect(io.stdout).toHaveBeenCalledWith(
      expect.stringContaining(`Authorization: ${outputPath}`)
    );
    expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await tempArtifacts(root)).toEqual([]);
  });

  it("returns 2, leaves no auth output, and writes a rejection receipt", async () => {
    const io = captureIo(async () => { throw new Error("matrix gate failed"); });

    expect(await runAuthorizeLongMemEvalMatrixCommand([
      "--contract", contractPath, "--out", outputPath
    ], io)).toBe(2);

    expect(lstatSync(outputPath, { throwIfNoEntry: false })).toBeUndefined();
    const rejectionPath = `${outputPath}.rejected.json`;
    const rejection = LongMemEvalMatrixPromotionRejectionSchema.parse(
      JSON.parse(await readFile(rejectionPath, "utf8")) as unknown
    );
    expect(rejection).toMatchObject({
      status: "rejected",
      error: { message: "matrix gate failed" },
      contract_path: contractPath,
      validator: null,
      validator_resolve_error: "fixture skips live validator resolution"
    });
    expect(await tempArtifacts(root)).toEqual([]);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("matrix gate failed"));
  });

  it("keeps a resolved dirty validator on the rejection receipt when authorize fails", async () => {
    const dirtyValidator = {
      ...promotionAuthorizationFixture().validator,
      worktree_clean: false
    };
    const io = captureIo(
      async () => { throw new Error("matrix gate failed"); },
      async () => dirtyValidator
    );

    expect(await runAuthorizeLongMemEvalMatrixCommand([
      "--contract", contractPath, "--out", outputPath
    ], io)).toBe(2);

    const rejection = LongMemEvalMatrixPromotionRejectionSchema.parse(
      JSON.parse(await readFile(`${outputPath}.rejected.json`, "utf8")) as unknown
    );
    expect(rejection.validator).toEqual(dirtyValidator);
    expect(rejection.validator_resolve_error).toBeNull();
  });

  it("rejects an invalid authorization before creating the target", async () => {
    const invalid = { ...promotionAuthorizationFixture(), status: "denied" };
    const io = captureIo(async () => invalid as never);

    expect(await runAuthorizeLongMemEvalMatrixCommand([
      "--contract", contractPath, "--out", outputPath
    ], io)).toBe(2);
    expect(lstatSync(outputPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(await tempArtifacts(root)).toEqual([]);
  });

  it.each(["file", "directory", "symlink"] as const)(
    "refuses to replace an existing output %s",
    async (kind) => {
      const referent = join(root, "referent.json");
      await writeFile(referent, "referent", "utf8");
      if (kind === "file") await writeFile(outputPath, "existing", "utf8");
      if (kind === "directory") await mkdir(outputPath);
      if (kind === "symlink") await symlink(referent, outputPath);
      const io = captureIo(async () => promotionAuthorizationFixture());

      expect(await runAuthorizeLongMemEvalMatrixCommand([
        "--contract", contractPath, "--out", outputPath
      ], io)).toBe(2);

      if (kind === "file") expect(await readFile(outputPath, "utf8")).toBe("existing");
      if (kind === "directory") expect((await lstat(outputPath)).isDirectory()).toBe(true);
      if (kind === "symlink") expect((await lstat(outputPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(referent, "utf8")).toBe("referent");
      expect(await tempArtifacts(root)).toEqual([]);
    }
  );

  it("rejects a symbolic-link contract without invoking authorization", async () => {
    const referent = join(root, "real-contract.json");
    const linked = join(root, "linked-contract.json");
    await writeFile(referent, "contract", "utf8");
    await symlink(referent, linked);
    const authorize = vi.fn(async () => promotionAuthorizationFixture());
    const io = captureIo(authorize);

    expect(await runAuthorizeLongMemEvalMatrixCommand([
      "--contract", linked, "--out", outputPath
    ], io)).toBe(2);
    expect(authorize).not.toHaveBeenCalled();
    expect(lstatSync(outputPath, { throwIfNoEntry: false })).toBeUndefined();
  });
});

function captureIo(
  authorize: LongMemEvalMatrixPromotionCommandDependencies["authorize"],
  resolveValidatorIdentity?: LongMemEvalMatrixPromotionCommandDependencies["resolveValidatorIdentity"]
): LongMemEvalMatrixPromotionCommandDependencies & {
  readonly stdout: ReturnType<typeof vi.fn>;
  readonly stderr: ReturnType<typeof vi.fn>;
} {
  const stdout = vi.fn();
  const stderr = vi.fn();
  return {
    authorize,
    resolveValidatorIdentity: resolveValidatorIdentity ?? (async () => {
      throw new Error("fixture skips live validator resolution");
    }),
    checkoutRoot: "/repo",
    stdout,
    stderr
  };
}

async function tempArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes(".tmp-"));
}
