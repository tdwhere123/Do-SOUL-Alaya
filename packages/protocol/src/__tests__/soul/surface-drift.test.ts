import { describe, expect, it } from "vitest";
import {
  DriftAlertSchema,
  DriftClassificationSchema,
  DriftSeveritySchema,
  DriftTypeSchema,
  GovernanceDriftLeaseSchema,
  SurfaceDriftOperationTypeSchema,
  classifyDriftSeverity
} from "../../soul/surface-drift.js";

const detectedAt = "2026-04-20T08:00:00.000Z";
const liveSurfaceDriftOperationTypes = [
  "surface.bind_object",
  "surface.rename_object",
  "surface.transition_binding_state",
  "surface.transition_status"
] as const;

describe("surface drift schemas", () => {
  it("accepts governance-critical classification and lease payloads", () => {
    expect(DriftSeveritySchema.parse("ordinary")).toBe("ordinary");
    expect(DriftSeveritySchema.parse("governance_critical")).toBe("governance_critical");
    expect(DriftTypeSchema.parse("scope_change")).toBe("scope_change");
    expect(liveSurfaceDriftOperationTypes.map((value) => SurfaceDriftOperationTypeSchema.parse(value))).toEqual(
      liveSurfaceDriftOperationTypes
    );
    expect(classifyDriftSeverity("scope_change")).toBe("governance_critical");
    expect(classifyDriftSeverity("theme_change")).toBe("ordinary");

    expect(
      DriftClassificationSchema.parse({
        drift_id: "drift-1",
        workspace_id: "workspace-1",
        drift_type: "scope_change",
        severity: "governance_critical",
        affected_subject: "surface_binding",
        description: "Surface binding changed from active to detached",
        detected_at: detectedAt
      })
    ).toEqual({
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change",
      severity: "governance_critical",
      affected_subject: "surface_binding",
      description: "Surface binding changed from active to detached",
      detected_at: detectedAt
    });

    expect(
      GovernanceDriftLeaseSchema.parse({
        lease_id: "lease-1",
        workspace_id: "workspace-1",
        operation_type: "surface.bind_object",
        granted_to: "user",
        drift_id: "drift-1",
        expires_at: "2026-04-20T08:05:00.000Z",
        granted_at: detectedAt
      })
    ).toMatchObject({
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.bind_object"
    });

    expect(
      DriftAlertSchema.parse({
        alert_id: "alert-1",
        workspace_id: "workspace-1",
        drift_id: "drift-1",
        severity: "governance_critical",
        message: "Governance-critical surface drift detected",
        alerted_at: detectedAt
      })
    ).toMatchObject({
      alert_id: "alert-1",
      severity: "governance_critical"
    });
  });

  it("rejects malformed severity and empty identifiers", () => {
    expect(() => DriftTypeSchema.parse("unexpected_drift")).toThrow();
    expect(() => SurfaceDriftOperationTypeSchema.parse("surface.delete_object")).toThrow();

    expect(() =>
      DriftClassificationSchema.parse({
        drift_id: "",
        workspace_id: "workspace-1",
        drift_type: "scope_change",
        severity: "critical",
        affected_subject: "surface_binding",
        description: "bad",
        detected_at: detectedAt
      })
    ).toThrow();

    expect(() =>
      GovernanceDriftLeaseSchema.parse({
        lease_id: "lease-1",
        workspace_id: "workspace-1",
        operation_type: "surface.delete_object",
        granted_to: "user",
        expires_at: "2026-04-20T08:05:00.000Z",
        granted_at: detectedAt
      })
    ).toThrow();

    expect(() =>
      DriftAlertSchema.parse({
        alert_id: "alert-1",
        workspace_id: "workspace-1",
        drift_id: "drift-1",
        severity: "ordinary",
        message: "ordinary drift is not alertable",
        alerted_at: detectedAt
      })
    ).toThrow();
  });
});
