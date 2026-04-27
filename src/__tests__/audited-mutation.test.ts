import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, type TempDir } from "./helpers.js";
import {
  AuditedMutationExecutionError,
  AuditedMutationNotificationError,
  MissingAuditInputError,
  type AuditedMutationInput
} from "../runtime/audit-types.js";
import { executeAuditedMutation } from "../runtime/audited-mutation.js";
import type { AtomicAuditLogWriter, AuditEventWrite, AuditLogWriter } from "../runtime/audited-mutation.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";

const baseInput: AuditedMutationInput = {
  kind: "memory.durable_write",
  source: {
    kind: "operator-note",
    ref: "task:ALA-R1",
    metadata: {
      token: "should-not-appear"
    }
  },
  evidence: [
    {
      kind: "task-card",
      ref: "docs/v0.1/task-cards/runtime-truth-kernel.md",
      summary: "R1 requires audit-first mutation coverage."
    }
  ],
  actor: "codex",
  target: {
    type: "runtime"
  },
  payload: {
    text: "Authorization: Bearer secret-token"
  }
};

describe("executeAuditedMutation", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("records intent, committed, and notified phases in order on success", async () => {
    const { storage } = await openStorage("alaya-audit-success-");
    const observed: string[] = [];
    try {
      const result = await executeAuditedMutation(
        storage,
        baseInput,
        ({ mutationId }) => {
          observed.push(`mutate:${mutationId}`);
          return { durableId: "mem_1" };
        },
        ({ mutationId }) => {
          observed.push(`notify:${mutationId}`);
        }
      );

      expect(result.committed).toBe(true);
      expect(result.notification).toBe("notified");
      expect(observed).toEqual([
        `mutate:${result.mutationId}`,
        `notify:${result.mutationId}`
      ]);
      const auditEvents = storage.listAuditEventsForMutation(result.mutationId);
      expect(auditEvents.map((event) => event.phase)).toEqual(["intent", "committed", "notified"]);
      expect(auditEvents[0]?.source.metadata?.token).toBe("[REDACTED]");
      expect(auditEvents[0]?.payload?.text).toBe("Authorization: Bearer [REDACTED]");
    } finally {
      storage.close();
    }
  });

  it("keeps audit evidence and marks mutation_failed when the durable mutation throws", async () => {
    const { storage } = await openStorage("alaya-audit-mutation-failure-");
    try {
      let mutationId: string | undefined;
      const rejection = await executeAuditedMutation(storage, baseInput, (context) => {
        mutationId = context.mutationId;
          throw new Error("password: sensitive");
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
      expect((rejection as Error & { cause?: { message?: string } }).cause?.message).toBe("password: [REDACTED]");
      expect((rejection as AuditedMutationExecutionError).failure.message).toBe("password: [REDACTED]");

      expect(mutationId).toBeDefined();
      const auditEvents = storage.listAuditEventsForMutation(mutationId ?? "");
      expect(auditEvents.map((event) => event.phase)).toEqual(["intent", "mutation_failed"]);
      expect(auditEvents[1]?.error?.message).toBe("password: [REDACTED]");
    } finally {
      storage.close();
    }
  });

  it("marks notification_failed and raises a committed notification error", async () => {
    const { storage } = await openStorage("alaya-audit-notification-failure-");
    try {
      let mutationId: string | undefined;
      const rejection = await executeAuditedMutation(
        storage,
        baseInput,
        () => "committed-value",
        (context) => {
          mutationId = context.mutationId;
          throw new Error("api_key notification-secret");
        }
      ).catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        name: "AuditedMutationNotificationError",
        code: "NOTIFICATION_FAILED",
        committed: true
      } satisfies Partial<AuditedMutationNotificationError>);
      expect((rejection as Error & { cause?: { message?: string } }).cause?.message).toBe("api_key [REDACTED]");
      expect((rejection as AuditedMutationNotificationError).failure.message).toBe("api_key [REDACTED]");

      expect(mutationId).toBeDefined();
      const auditEvents = storage.listAuditEventsForMutation(mutationId ?? "");
      expect(auditEvents.map((event) => event.phase)).toEqual(["intent", "committed", "notification_failed"]);
      expect(auditEvents[2]?.error?.message).toBe("api_key [REDACTED]");
    } finally {
      storage.close();
    }
  });

  it("returns deterministic mutation failure when writing the failure audit event fails", async () => {
    const auditLog = new FailingFailureAuditLog("mutation_failed");

    const rejection = await executeAuditedMutation(auditLog, baseInput, () => {
      throw new Error("token raw-secret");
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
    expect((rejection as AuditedMutationExecutionError).mutationId).toBe(auditLog.mutationId);
    expect((rejection as AuditedMutationExecutionError).failure.message).toBe("token [REDACTED]");
    expect((rejection as AuditedMutationExecutionError).auditWriteFailure?.message).toBe("secret: [REDACTED]");
    expect(auditLog.phases).toEqual(["intent", "mutation_failed"]);
  });

  it("returns committed notification failure when writing the notification failure audit event fails", async () => {
    const auditLog = new FailingFailureAuditLog("notification_failed");

    const rejection = await executeAuditedMutation(
      auditLog,
      baseInput,
      () => "committed",
      () => {
        throw new Error("token raw-secret");
      }
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AuditedMutationNotificationError);
    expect((rejection as AuditedMutationNotificationError).committed).toBe(true);
    expect((rejection as AuditedMutationNotificationError).mutationId).toBe(auditLog.mutationId);
    expect((rejection as AuditedMutationNotificationError).failure.message).toBe("token [REDACTED]");
    expect((rejection as AuditedMutationNotificationError).auditWriteFailure?.message).toBe("secret: [REDACTED]");
    expect(auditLog.phases).toEqual(["intent", "committed", "notification_failed"]);
  });

  it("redacts CLI-style secret values in audit payload strings", async () => {
    const { storage } = await openStorage("alaya-audit-cli-redaction-");
    try {
      const result = await executeAuditedMutation(
        storage,
        {
          ...baseInput,
          payload: {
            text: "run --token=abc123 --secret hidden --authorization raw"
          }
        },
        () => "ok"
      );

      const auditEvents = storage.listAuditEventsForMutation(result.mutationId);
      expect(auditEvents[0]?.payload?.text).toBe("run --token=[REDACTED] --secret [REDACTED] --authorization [REDACTED]");
    } finally {
      storage.close();
    }
  });

  it("redacts actor strings before storing audit events", async () => {
    const { storage } = await openStorage("alaya-audit-actor-redaction-");
    try {
      const result = await executeAuditedMutation(
        storage,
        {
          ...baseInput,
          actor: "operator --token=raw-secret"
        },
        () => "ok"
      );

      const auditEvents = storage.listAuditEventsForMutation(result.mutationId);
      expect(auditEvents[0]?.actor).toBe("operator --token=[REDACTED]");
    } finally {
      storage.close();
    }
  });

  it("rejects durable mutations without explicit source or evidence before audit write", async () => {
    const { storage } = await openStorage("alaya-audit-invalid-");
    try {
      await expect(
        executeAuditedMutation(
          storage,
          {
            ...baseInput,
            evidence: []
          },
          () => "never-called"
        )
      ).rejects.toBeInstanceOf(MissingAuditInputError);
    } finally {
      storage.close();
    }
  });

  it("rolls back atomic domain writes if the committed audit event cannot be written", async () => {
    const auditLog = new FailingCommittedAtomicAuditLog();

    const rejection = await executeAuditedMutation(auditLog, baseInput, () => {
      auditLog.domainWrites.push("durable-write");
      return "would-have-committed";
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
    expect((rejection as AuditedMutationExecutionError).mutationId).toBe(auditLog.mutationId);
    expect(auditLog.domainWrites).toEqual([]);
    expect(auditLog.phases).toEqual(["intent", "committed", "mutation_failed"]);
  });

  async function openStorage(prefix: string): Promise<{ storage: SqliteAlayaStorage }> {
    const temp = await createTempDir(prefix);
    tempDirs.push(temp);
    return {
      storage: await SqliteAlayaStorage.open({ dataDir: temp.path })
    };
  }
});

class FailingFailureAuditLog implements AuditLogWriter {
  public readonly phases: string[] = [];
  public mutationId = "";

  public constructor(private readonly phaseToFail: string) {}

  public async appendAuditEvent(event: AuditEventWrite) {
    this.phases.push(event.phase);
    this.mutationId = event.mutationId;
    if (event.phase === this.phaseToFail) {
      throw new Error("secret: audit-write-failed");
    }
    return {
      auditEventId: `${event.phase}-event`,
      mutationId: event.mutationId,
      phase: event.phase,
      status: event.status,
      mutationKind: event.input.kind,
      source: event.input.source,
      evidence: event.input.evidence,
      createdAt: new Date().toISOString()
    };
  }
}

class FailingCommittedAtomicAuditLog implements AtomicAuditLogWriter {
  public readonly phases: string[] = [];
  public readonly domainWrites: string[] = [];
  public mutationId = "";

  public async appendAuditEvent(event: AuditEventWrite) {
    this.phases.push(event.phase);
    this.mutationId = event.mutationId;
    if (event.phase === "committed") {
      throw new Error("secret: committed-audit-failed");
    }
    return {
      auditEventId: `${event.phase}-event`,
      mutationId: event.mutationId,
      phase: event.phase,
      status: event.status,
      mutationKind: event.input.kind,
      source: event.input.source,
      evidence: event.input.evidence,
      createdAt: new Date().toISOString()
    };
  }

  public async executeAtomic<T>(operation: () => Promise<T> | T): Promise<T> {
    const before = [...this.domainWrites];
    try {
      return await operation();
    } catch (error) {
      this.domainWrites.splice(0, this.domainWrites.length, ...before);
      throw error;
    }
  }
}
