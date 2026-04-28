import { errorToRedactedJson } from "../runtime/redaction.js";
import { alayaPackageName, alayaPackageVersion } from "../package-info.js";

export type DoctorComponentStatus = "ok" | "failed" | "not_implemented";

export interface DoctorComponent {
  readonly status: DoctorComponentStatus;
  readonly detail: string;
}

export interface DoctorAppliedMigration {
  readonly id: string;
  readonly appliedAt: string;
}

export interface DoctorStorageReport {
  readonly driver: "node:sqlite";
  readonly database: "initialized" | "unavailable";
  readonly migrations: readonly DoctorAppliedMigration[];
}

export interface DoctorReport {
  readonly schema_version: 1;
  readonly product: "Do-SOUL Alaya";
  readonly r1_baseline_ready: boolean;
  readonly foundation_contracts_ready: boolean;
  readonly runtime_use_proof_ready: boolean;
  readonly activation_operations_ready: boolean;
  readonly product_ready: false;
  readonly package: DoctorComponent & {
    readonly name: string;
    readonly version: string;
  };
  readonly runtime: DoctorComponent & {
    readonly api: "AlayaRuntimePort";
  };
  readonly storage: DoctorComponent & DoctorStorageReport;
  readonly ontology: DoctorComponent;
  readonly structure: DoctorComponent;
  readonly governance: DoctorComponent;
  readonly recall: DoctorComponent;
  readonly profile: DoctorComponent;
  readonly provider: DoctorComponent;
  readonly session_trust: DoctorComponent;
  readonly integration: DoctorComponent;
  readonly mcp: DoctorComponent;
  readonly cli_fallback: DoctorComponent;
  readonly gateway: DoctorComponent;
  readonly operations: DoctorComponent;
}

export function createDoctorReport(storage: DoctorStorageReport): DoctorReport {
  return {
    schema_version: 1,
    product: "Do-SOUL Alaya",
    r1_baseline_ready: true,
    foundation_contracts_ready: true,
    runtime_use_proof_ready: true,
    activation_operations_ready: true,
    product_ready: false,
    package: {
      status: "ok",
      detail: "Root package metadata and public exports are present.",
      name: alayaPackageName,
      version: alayaPackageVersion
    },
    runtime: {
      status: "ok",
      detail: "Public runtime port exposes audited R1 decisions, R2/R3/R4 foundation operations, and R5/R6/R7 recall, provider proposal, and session trust operations; callback-based mutation orchestration stays internal.",
      api: "AlayaRuntimePort"
    },
    storage: {
      status: "ok",
      detail: "SQLite storage initialized through the runtime-owned service.",
      ...storage
    },
    ontology: {
      status: "ok",
      detail: "R2 ontology validators and runtime-owned durable write operations require source, evidence, usable evidence refs, and audit."
    },
    structure: {
      status: "ok",
      detail: "R3 PathRelation, runtime-only ActivationCandidate, manifestation resolver, and read-only topology projection contracts are available."
    },
    governance: {
      status: "ok",
      detail: "R4 promotion gate, HITL/operator reason policy, and governance bypass fail-closed signal are available."
    },
    recall: {
      status: "ok",
      detail: "R5 structured/lexical/path-aware recall, opt-in embedding supplement degradation, and runtime-only context pack contracts are available."
    },
    profile: {
      status: "ok",
      detail: "R8/R9 profile precedence, explicit project override preview/audit, and Attach/Profile preview/confirm result contracts are available; real profile file mutation remains future work."
    },
    provider: {
      status: "ok",
      detail: "R6 provider capability selection and proposal-only records are available; concrete external provider adapters remain future integration work."
    },
    session_trust: {
      status: "ok",
      detail: "R7 session lifecycle, context delivery, usage proof, trust summary, and delivered-is-not-used semantics are available."
    },
    integration: {
      status: "ok",
      detail: "R8 integration operation descriptors route MCP/CLI-facing requests through the injected runtime boundary without exposing storage internals."
    },
    mcp: {
      status: "ok",
      detail: "R8 MCP surface descriptors, tool/resource/prompt metadata, and injected runtime operation invocation helpers are available; no live MCP transport/server is claimed."
    },
    cli_fallback: {
      status: "ok",
      detail: "R8 CLI fallback request normalization, parity shape, and redacted response helpers are available; doctor remains the only executable CLI command."
    },
    gateway: {
      status: "ok",
      detail: "R8 Gateway envelope and evidence-link helpers default to audit mode, support explicit strict mode, and do not claim durable truth or usage proof."
    },
    operations: {
      status: "ok",
      detail: "R9 profile, secret-ref, provider status, portable bundle, backup metadata, and read-only operations status contracts are available."
    }
  };
}

export function createDoctorFailureReport(error: unknown): DoctorReport {
  const redactedError = errorToRedactedJson(error);
  return {
    schema_version: 1,
    product: "Do-SOUL Alaya",
    r1_baseline_ready: false,
    foundation_contracts_ready: false,
    runtime_use_proof_ready: false,
    activation_operations_ready: false,
    product_ready: false,
    package: {
      status: "ok",
      detail: "Root package metadata and public exports are present.",
      name: alayaPackageName,
      version: alayaPackageVersion
    },
    runtime: {
      status: "failed",
      detail: `Runtime initialization failed: ${String(redactedError.message)}.`,
      api: "AlayaRuntimePort"
    },
    storage: {
      status: "failed",
      detail: `SQLite storage initialization failed: ${String(redactedError.message)}.`,
      driver: "node:sqlite",
      database: "unavailable",
      migrations: []
    },
    ontology: {
      status: "failed",
      detail: `Foundation contract readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    structure: {
      status: "failed",
      detail: `Foundation contract readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    governance: {
      status: "failed",
      detail: `Foundation contract readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    recall: {
      status: "failed",
      detail: `Runtime use proof readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    profile: {
      status: "failed",
      detail: `Profile and Attach/Profile readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    provider: {
      status: "failed",
      detail: `Provider/proposal readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    session_trust: {
      status: "failed",
      detail: `Session trust readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    integration: {
      status: "failed",
      detail: `Integration operation readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    mcp: {
      status: "failed",
      detail: `MCP surface readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    cli_fallback: {
      status: "failed",
      detail: `CLI fallback readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    gateway: {
      status: "failed",
      detail: `Gateway readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    },
    operations: {
      status: "failed",
      detail: `Operations readiness unavailable because runtime initialization failed: ${String(redactedError.message)}.`
    }
  };
}
