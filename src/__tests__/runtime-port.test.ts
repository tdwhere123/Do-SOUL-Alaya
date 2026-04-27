import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, type TempDir } from "./helpers.js";
import { createAlayaRuntime } from "../index.js";
import {
  InvalidRuntimeDecisionKindError,
  MissingAuditInputError
} from "../runtime/audit-types.js";
import type { AuditedRuntimeDecisionInput } from "../runtime/types.js";

const decisionInput: AuditedRuntimeDecisionInput = {
  kind: "runtime.r1_decision",
  source: {
    kind: "test",
    ref: "runtime-port.test"
  },
  evidence: [
    {
      kind: "test",
      ref: "runtime-port.test"
    }
  ],
  payload: {
    decision: "record R1 runtime-owned audit decision"
  }
};

describe("AlayaRuntimePort", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("exposes a runtime-owned state-changing audit decision without caller mutation callbacks", async () => {
    const temp = await createTempDir("alaya-runtime-port-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      const result = await runtime.recordAuditedRuntimeDecision(decisionInput);

      expect(result.committed).toBe(true);
      expect(result.notification).toBe("not_requested");
      expect(result.result).toMatchObject({
        mutationId: result.mutationId,
        recorded: true,
        scope: "r1-runtime-audit"
      });
    } finally {
      await runtime.close();
    }
  });

  it("applies source and evidence validation through the public runtime-owned decision boundary", async () => {
    const temp = await createTempDir("alaya-runtime-port-invalid-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await expect(
        runtime.recordAuditedRuntimeDecision({
          ...decisionInput,
          evidence: []
        })
      ).rejects.toBeInstanceOf(MissingAuditInputError);
    } finally {
      await runtime.close();
    }
  });

  it("rejects non-runtime decision kinds through the public state-changing boundary", async () => {
    const temp = await createTempDir("alaya-runtime-port-kind-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      const rejection = await runtime.recordAuditedRuntimeDecision({
          ...decisionInput,
          kind: "memory.durable_write --authorization=raw-secret"
        } as AuditedRuntimeDecisionInput)
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(InvalidRuntimeDecisionKindError);
      expect((rejection as Error).message).toContain("--authorization=[REDACTED]");
      expect((rejection as Error).message).not.toContain("raw-secret");
    } finally {
      await runtime.close();
    }
  });
});
