import type {
  AuditedMutationInput,
  AuditedMutationResult
} from "./audit-types.js";
import type { DoctorReport } from "../doctor/report.js";

export interface AlayaRuntimeOptions {
  readonly dataDir: string;
}

export interface AuditedRuntimeDecisionReceipt {
  readonly mutationId: string;
  readonly recorded: true;
  readonly scope: "r1-runtime-audit";
}

export interface AuditedRuntimeDecisionInput extends Omit<AuditedMutationInput, "kind"> {
  readonly kind: `runtime.${string}`;
}

export interface AlayaRuntimePort {
  recordAuditedRuntimeDecision(
    input: AuditedRuntimeDecisionInput
  ): Promise<AuditedMutationResult<AuditedRuntimeDecisionReceipt>>;
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}
