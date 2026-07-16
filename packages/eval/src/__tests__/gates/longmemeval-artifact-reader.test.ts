import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLongMemEvalArtifactReader } from
  "../../gates/longmemeval-artifact-reader.js";

type ArtifactRole = "manifest" | "diagnostics";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("LongMemEval hardened artifact reader", () => {
  it("reads bytes, strict UTF-8, and JSON through the role policy", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "artifact.json"), '{"answer":42}\n', "utf8");
    const reader = createReader(root);

    expect(Buffer.from(await reader.readBytes("manifest", "artifact.json")).toString())
      .toBe('{"answer":42}\n');
    await expect(reader.readUtf8("manifest", "artifact.json"))
      .resolves.toBe('{"answer":42}\n');
    await expect(reader.readJson("manifest", "artifact.json"))
      .resolves.toEqual({ answer: 42 });
  });

  it("enforces the cap associated with the requested role", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "artifact.json"), "12345", "utf8");
    const reader = createLongMemEvalArtifactReader<ArtifactRole>({
      root,
      maxBytesByRole: { manifest: 4, diagnostics: 5 }
    });

    await expect(reader.readBytes("manifest", "artifact.json"))
      .rejects.toMatchObject({ code: "size_limit_exceeded" });
    await expect(reader.readUtf8("diagnostics", "artifact.json"))
      .resolves.toBe("12345");
  });

  it.each([
    "",
    "../outside.json",
    "/tmp/outside.json",
    "nested/./artifact.json",
    "nested\\..\\outside.json",
    "C:\\outside.json",
    "artifact.json:alternate-stream"
  ])("rejects unsafe artifact reference %j", async (reference) => {
    const root = await fixtureRoot();

    await expect(createReader(root).readBytes("manifest", reference))
      .rejects.toMatchObject({ code: "unsafe_reference" });
  });

  it("rejects a final symlink without reading its target", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(path.join(outside, "secret.json"), "secret-value", "utf8");
    await symlink(path.join(outside, "secret.json"), path.join(root, "artifact.json"));

    const error = await rejected(createReader(root).readUtf8("manifest", "artifact.json"));
    expect(error).toMatchObject({ code: "symbolic_link" });
    expect(String(error)).not.toContain("secret-value");
  });

  it("rejects an intermediate symlink that escapes the declared root", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(path.join(outside, "artifact.json"), "outside", "utf8");
    await symlink(outside, path.join(root, "linked"));

    await expect(createReader(root).readUtf8("manifest", "linked/artifact.json"))
      .rejects.toMatchObject({ code: "outside_root" });
  });

  it("allows an intermediate symlink whose opened file remains inside the root", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "actual"));
    await writeFile(path.join(root, "actual", "artifact.json"), "inside", "utf8");
    await symlink("actual", path.join(root, "linked"));

    await expect(createReader(root).readUtf8("manifest", "linked/artifact.json"))
      .resolves.toBe("inside");
  });

  it("rejects non-regular artifacts", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "directory"));

    await expect(createReader(root).readBytes("manifest", "directory"))
      .rejects.toMatchObject({ code: "not_regular_file" });
  });

  it("rejects invalid UTF-8 and JSON without exposing artifact contents", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "invalid-utf8.json"), Buffer.from([0xc3, 0x28]));
    const secret = "private-payload-marker";
    await writeFile(path.join(root, "invalid-json.json"), `{${secret}`, "utf8");
    const reader = createReader(root);

    const utf8Error = await rejected(reader.readUtf8("manifest", "invalid-utf8.json"));
    expect(utf8Error).toMatchObject({ code: "invalid_utf8" });
    const jsonError = await rejected(reader.readJson("manifest", "invalid-json.json"));
    expect(jsonError).toMatchObject({ code: "invalid_json" });
    expect(String(jsonError)).not.toContain(secret);
  });

  it.skipIf(process.platform !== "linux")(
    "rejects descriptor data that exceeds its fstat size",
    async () => {
      const reader = createLongMemEvalArtifactReader<ArtifactRole>({
        root: "/proc/self",
        maxBytesByRole: { manifest: 64 * 1024, diagnostics: 64 * 1024 }
      });

      await expect(reader.readBytes("manifest", "status"))
        .rejects.toMatchObject({ code: "unstable_file" });
    }
  );
});

function createReader(root: string) {
  return createLongMemEvalArtifactReader<ArtifactRole>({
    root,
    maxBytesByRole: { manifest: 1024, diagnostics: 2048 }
  });
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eval-artifact-reader-"));
  roots.push(root);
  return root;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
