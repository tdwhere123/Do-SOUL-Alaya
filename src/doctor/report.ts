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
  readonly profile: DoctorComponent;
  readonly provider: DoctorComponent;
}

export function createDoctorReport(storage: DoctorStorageReport): DoctorReport {
  return {
    schema_version: 1,
    product: "Do-SOUL Alaya",
    r1_baseline_ready: true,
    foundation_contracts_ready: true,
    product_ready: false,
    package: {
      status: "ok",
      detail: "Root package metadata and public exports are present.",
      name: alayaPackageName,
      version: alayaPackageVersion
    },
    runtime: {
      status: "ok",
      detail: "Public runtime port exposes audited R1 decisions plus R2/R3/R4 ontology, structure, manifestation, and governance operations; callback-based mutation orchestration stays internal.",
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
    profile: {
      status: "not_implemented",
      detail: "Attach/Profile installer is outside the current foundation slice and remains explicit future work."
    },
    provider: {
      status: "not_implemented",
      detail: "Provider, recall, and agent usage proof are outside the current foundation slice and are not implied by doctor."
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
    profile: {
      status: "not_implemented",
      detail: "Attach/Profile installer is outside the current foundation slice and remains explicit future work."
    },
    provider: {
      status: "not_implemented",
      detail: "Provider, recall, and agent usage proof are outside the current foundation slice and are not implied by doctor."
    }
  };
}
