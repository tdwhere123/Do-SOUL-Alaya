import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSecretRef, type SecretRefReader } from "../secrets.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
  tempDirs.clear();
});

describe("secrets resolver", () => {
  it("resolves env references via injected reader", () => {
    const result = resolveSecretRef(
      "env:OPENAI_API_KEY",
      createReader({
        readEnv: (name) => (name === "OPENAI_API_KEY" ? "resolved-env-value" : undefined)
      })
    );

    expect(result).toEqual({
      ref: "env:OPENAI_API_KEY",
      value: "resolved-env-value",
      origin: "env"
    });
  });

  it("returns env_missing when an env variable is absent", () => {
    const result = resolveSecretRef("env:OPENAI_API_KEY", createReader());

    expect(result).toEqual({
      kind: "env_missing",
      ref: "env:OPENAI_API_KEY",
      var_name: "OPENAI_API_KEY"
    });
  });

  it("returns empty for whitespace-only env values", () => {
    const result = resolveSecretRef(
      "env:OPENAI_API_KEY",
      createReader({
        readEnv: () => " \n\t "
      })
    );

    expect(result).toEqual({
      kind: "empty",
      ref: "env:OPENAI_API_KEY",
      origin: "env"
    });
  });

  it.each(["env:", "env:9OPENAI_API_KEY", "env:OPENAI-API-KEY"])(
    "returns malformed for invalid env ref %s",
    (ref) => {
      const result = resolveSecretRef(ref, createReader());

      expect(result).toMatchObject({
        kind: "malformed",
        ref
      });
    }
  );

  it("resolves file references with trailing whitespace trimmed", () => {
    const result = resolveSecretRef(
      "file:/tmp/secret-file",
      createReader({
        readFile: () => "line-one  \n\n"
      })
    );

    expect(result).toEqual({
      ref: "file:/tmp/secret-file",
      value: "line-one",
      origin: "file"
    });
  });

  it("returns malformed for non-absolute file paths", () => {
    const relativeRef = resolveSecretRef("file:relative/path", createReader());
    const emptyRef = resolveSecretRef("file:", createReader());

    expect(relativeRef).toMatchObject({
      kind: "malformed",
      ref: "file:relative/path"
    });
    expect(emptyRef).toMatchObject({
      kind: "malformed",
      ref: "file:"
    });
  });

  it("returns file_missing when file reader reports ENOENT", () => {
    const result = resolveSecretRef(
      "file:/tmp/missing-secret",
      createReader({
        readFile: () => {
          const error = new Error("missing");
          Object.assign(error, { code: "ENOENT" });
          throw error;
        }
      })
    );

    expect(result).toEqual({
      kind: "file_missing",
      ref: "file:/tmp/missing-secret",
      path: "/tmp/missing-secret"
    });
  });

  it("returns file_unreadable with safe cause and no plaintext leakage", () => {
    const result = resolveSecretRef(
      "file:/tmp/locked-secret",
      createReader({
        readFile: () => {
          const error = new Error("do not expose sensitive-marker");
          Object.assign(error, { code: "EACCES" });
          throw error;
        }
      })
    );

    expect(result).toEqual({
      kind: "file_unreadable",
      ref: "file:/tmp/locked-secret",
      path: "/tmp/locked-secret",
      cause: "EACCES"
    });
    expect(JSON.stringify(result)).not.toContain("sensitive-marker");
  });

  it("returns empty for file content that becomes empty after trimEnd", () => {
    const result = resolveSecretRef(
      "file:/tmp/empty-secret",
      createReader({
        readFile: () => " \n\t "
      })
    );

    expect(result).toEqual({
      kind: "empty",
      ref: "file:/tmp/empty-secret",
      origin: "file"
    });
  });

  it("uses default reader for local temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alaya-secrets-"));
    tempDirs.add(dir);
    const secretPath = path.join(dir, "provider-token");
    await writeFile(secretPath, "resolved-file-value\n", "utf8");

    const result = resolveSecretRef(`file:${secretPath}`);

    expect(result).toEqual({
      ref: `file:${secretPath}`,
      value: "resolved-file-value",
      origin: "file"
    });
  });

  it("resolves keychain references via injected reader", () => {
    const result = resolveSecretRef(
      "keychain:prod:openai",
      createReader({
        readKeychain: (service, account) =>
          service === "prod" && account === "openai" ? "resolved-keychain-value\n" : {
            kind: "keychain_entry_not_found",
            service,
            account,
            reason: "missing"
          }
      })
    );

    expect(result).toEqual({
      ref: "keychain:prod:openai",
      value: "resolved-keychain-value",
      origin: "keychain"
    });
  });

  it.each([
    "keychain:",
    "keychain:onlyservice",
    "keychain:a:b:c",
    "keychain::acct",
    "keychain:svc:",
    "keychain:alaya: openai",
    "keychain:alaya:openai ",
    "keychain: alaya:openai",
    "keychain:alaya:open\tai",
    "keychain:alaya:open\nai",
    "keychain:alaya:open\"ai",
    "keychain:alaya:open$ai",
    "keychain:-alaya:openai",
    "keychain:alaya:--openai"
  ])(
    "returns malformed for invalid keychain ref %j",
    (ref) => {
      const result = resolveSecretRef(ref, createReader());

      expect(result).toMatchObject({
        kind: "malformed",
        ref
      });
    }
  );

  it("returns keychain_tooling_unavailable with remediation details", () => {
    const result = resolveSecretRef(
      "keychain:prod:openai",
      createReader({
        readKeychain: (service, account) => ({
          kind: "keychain_tooling_unavailable",
          service,
          account,
          reason: "install platform keychain tooling"
        })
      })
    );

    expect(result).toEqual({
      kind: "keychain_tooling_unavailable",
      ref: "keychain:prod:openai",
      service: "prod",
      account: "openai",
      reason: "install platform keychain tooling"
    });
    expect(JSON.stringify(result)).not.toContain("resolved-keychain-value");
  });

  it("returns keychain_entry_not_found when the platform adapter misses", () => {
    const result = resolveSecretRef(
      "keychain:prod:openai",
      createReader({
        readKeychain: (service, account) => ({
          kind: "keychain_entry_not_found",
          service,
          account,
          reason: "not found"
        })
      })
    );

    expect(result).toEqual({
      kind: "keychain_entry_not_found",
      ref: "keychain:prod:openai",
      service: "prod",
      account: "openai",
      reason: "not found"
    });
  });

  it("returns empty for keychain values that become empty after trimEnd", () => {
    const result = resolveSecretRef(
      "keychain:prod:openai",
      createReader({
        readKeychain: () => " \n\t "
      })
    );

    expect(result).toEqual({
      kind: "empty",
      ref: "keychain:prod:openai",
      origin: "keychain"
    });
  });

  it("returns malformed for unsupported secret-ref schemes", () => {
    const result = resolveSecretRef("vault:prod:openai", createReader());

    expect(result).toMatchObject({
      kind: "malformed",
      ref: "vault:prod:openai"
    });
  });
});

function createReader(overrides: Partial<SecretRefReader> = {}): SecretRefReader {
  return {
    readEnv: () => undefined,
    readFile: () => {
      throw new Error("unexpected readFile call");
    },
    readKeychain: () => {
      throw new Error("unexpected readKeychain call");
    },
    ...overrides
  };
}
