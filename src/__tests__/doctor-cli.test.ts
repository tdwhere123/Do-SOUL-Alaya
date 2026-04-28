import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, type TempDir } from "./helpers.js";
import { runCli } from "../cli/doctor.js";
import { createAlayaRuntime } from "../index.js";

describe("doctor status", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("reports runtime-use-proof plus R8/R9 activation/operations readiness without claiming product readiness", async () => {
    const temp = await createTempDir("alaya-doctor-report-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await expect(runtime.doctor()).resolves.toMatchObject({
        schema_version: 1,
        product: "Do-SOUL Alaya",
        r1_baseline_ready: true,
        foundation_contracts_ready: true,
        runtime_use_proof_ready: true,
        activation_operations_ready: true,
        product_ready: false,
        package: {
          status: "ok",
          name: "@do-soul/alaya"
        },
        runtime: {
          status: "ok",
          api: "AlayaRuntimePort"
        },
        storage: {
          status: "ok",
          driver: "node:sqlite",
          database: "initialized"
        },
        ontology: {
          status: "ok"
        },
        structure: {
          status: "ok"
        },
        governance: {
          status: "ok"
        },
        recall: {
          status: "ok"
        },
        profile: {
          status: "ok"
        },
        provider: {
          status: "ok"
        },
        session_trust: {
          status: "ok"
        },
        integration: {
          status: "ok"
        },
        mcp: {
          status: "ok"
        },
        cli_fallback: {
          status: "ok"
        },
        gateway: {
          status: "ok"
        },
        operations: {
          status: "ok"
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("prints stable JSON through the CLI doctor command", async () => {
    const temp = await createTempDir("alaya-doctor-cli-");
    tempDirs.push(temp);
    let stdout = "";
    let stderr = "";

    await expect(
      runCli(["doctor", "--data-dir", temp.path], {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          }
        },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          }
        }
      })
    ).resolves.toBe(0);

    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      product_ready: boolean;
      runtime_use_proof_ready: boolean;
      activation_operations_ready: boolean;
      profile: { status: string };
      provider: { status: string };
      recall: { status: string };
      session_trust: { status: string };
      integration: { status: string };
      mcp: { status: string };
      cli_fallback: { status: string };
      gateway: { status: string };
      operations: { status: string };
    };
    expect(report.product_ready).toBe(false);
    expect(report.runtime_use_proof_ready).toBe(true);
    expect(report.activation_operations_ready).toBe(true);
    expect(report.profile.status).toBe("ok");
    expect(report.provider.status).toBe("ok");
    expect(report.recall.status).toBe("ok");
    expect(report.session_trust.status).toBe("ok");
    expect(report.integration.status).toBe("ok");
    expect(report.mcp.status).toBe("ok");
    expect(report.cli_fallback.status).toBe("ok");
    expect(report.gateway.status).toBe("ok");
    expect(report.operations.status).toBe("ok");
    expect(stdout).toContain("secret-ref");
    expect(stdout).not.toMatch(/raw-secret|authorization|bearer|password=/i);
  });

  it("prints structured failure JSON when runtime/storage initialization fails", async () => {
    const temp = await createTempDir("alaya-doctor-failure-");
    tempDirs.push(temp);
    const filePath = join(temp.path, "not-a-directory");
    await writeFile(filePath, "not a data dir", "utf8");
    let stdout = "";
    let stderr = "";

    await expect(
      runCli(["doctor", "--data-dir", filePath], {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          }
        },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          }
        }
      })
    ).resolves.toBe(1);

    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      r1_baseline_ready: boolean;
      foundation_contracts_ready: boolean;
      runtime_use_proof_ready: boolean;
      activation_operations_ready: boolean;
      runtime: { status: string; detail: string };
      storage: { status: string; database: string };
    };
    expect(report.r1_baseline_ready).toBe(false);
    expect(report.foundation_contracts_ready).toBe(false);
    expect(report.runtime_use_proof_ready).toBe(false);
    expect(report.activation_operations_ready).toBe(false);
    expect(report.runtime.status).toBe("failed");
    expect(report.storage.status).toBe("failed");
    expect(report.storage.database).toBe("unavailable");
  });

  it("redacts secret-looking unknown CLI arguments on stderr", async () => {
    let stdout = "";
    let stderr = "";

    await expect(
      runCli(["doctor", "--authorization=raw-secret"], {
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
            return true;
          }
        },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
            return true;
          }
        }
      })
    ).resolves.toBe(2);

    expect(stdout).toBe("");
    expect(stderr).toContain("--authorization=[REDACTED]");
    expect(stderr).not.toContain("raw-secret");
  });
});
