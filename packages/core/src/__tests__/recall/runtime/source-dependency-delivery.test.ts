import { expect, it } from "vitest";
import { HostDependencyExposureSchema, sourceIndexTarget,
  type HostOccurrence, type HostSourceDependency, type SourceIndexQueryRepository } from "@do-soul/alaya-protocol";
import { readSourceDependencyDelivery } from "../../../recall/runtime/source-dependency-delivery.js";

it("keeps a forged continuation's saturated cyclic traversal inside the exposure protocol bound", () => {
  const reference = (id: string): HostSourceDependency => ({ source_id: id, root_id: id, source_version: "1",
    content_digest: `sha256:${"c".repeat(64)}`, occurrence_id: "message" });
  const own = reference("root");
  const repository: Pick<SourceIndexQueryRepository, "readHostDependency"> = {
    readHostDependency: (workspace, bound) => {
      const ref = reference(bound.root_id);
      const source = sourceIndexTarget({ kind: "source_evidence", workspace_id: workspace, root_kind: "source_record",
        root_id: ref.root_id, source_version: ref.source_version, content_digest: ref.content_digest, evidence_object_id: null }, ref.source_id, 1);
      const occurrence: HostOccurrence = { occurrence_id: "message", utf8_span: [0, 1], role: "user", channel: null,
        author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
        completeness: "complete", fidelity: "original_bytes", semantic_dependencies: bound.root_id === own.root_id
          ? Array.from({ length: 32 }, (_, index) => reference(`target-${index}`)) : Array(32).fill(ref) };
      return { status: "ready", source, occurrence, inventory: { contract: "host-occurrence-v1",
        issuer: { namespace: "fixture", workspace_id: workspace, producer: "fixture", basis: "pinned_dataset" }, occurrences: [occurrence] },
        resources: { work: 1, native_bytes: 0, memory_bytes: 0, sql_internal_work: "unknown" } };
    }
  };
  const result = readSourceDependencyDelivery(repository, { target: { kind: "source_evidence", workspace_id: "workspace",
    root_kind: "source_record", root_id: own.root_id, source_version: own.source_version,
    content_digest: own.content_digest, evidence_object_id: null }, span: [0, 1], authorizedScopes: null,
    budget: { work_units: 1_000_000, memory_bytes: 16_000_000 }, continuation: {
      reference: reference("not-recorded"), source_occurrence_id: "message", source_span: [0, 1], start_offset: 0 } });
  expect(result.exposure.status).toBe("partial");
  expect(result.exposure.prerequisites).toHaveLength(256);
  expect(HostDependencyExposureSchema.safeParse(result.exposure).success).toBe(true);
});
