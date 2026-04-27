import { createDoctorReport } from "../doctor/report.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";
import { executeAuditedMutation as executeWithAuditLog } from "./audited-mutation.js";
import type {
  AuditedMutationResult
} from "./audit-types.js";
import { InvalidRuntimeDecisionKindError } from "./audit-types.js";
import type {
  AlayaRuntimeOptions,
  AlayaRuntimePort,
  AuditedRuntimeDecisionInput,
  AuditedRuntimeDecisionReceipt
} from "./types.js";
import type { DoctorReport } from "../doctor/report.js";

export async function createAlayaRuntime(options: AlayaRuntimeOptions): Promise<AlayaRuntimePort> {
  const storage = await SqliteAlayaStorage.open(options);
  return new AlayaRuntime(storage);
}

class AlayaRuntime implements AlayaRuntimePort {
  public constructor(private readonly storage: SqliteAlayaStorage) {}

  public async recordAuditedRuntimeDecision(
    input: AuditedRuntimeDecisionInput
  ): Promise<AuditedMutationResult<AuditedRuntimeDecisionReceipt>> {
    assertRuntimeDecisionKind(input.kind);
    return await executeWithAuditLog(this.storage, input, ({ mutationId }) => ({
      mutationId,
      recorded: true,
      scope: "r1-runtime-audit"
    }));
  }

  public async doctor(): Promise<DoctorReport> {
    return createDoctorReport(this.storage.getDoctorSnapshot());
  }

  public async close(): Promise<void> {
    this.storage.close();
  }
}

function assertRuntimeDecisionKind(kind: string): void {
  if (!kind.startsWith("runtime.")) {
    throw new InvalidRuntimeDecisionKindError(kind);
  }
}
