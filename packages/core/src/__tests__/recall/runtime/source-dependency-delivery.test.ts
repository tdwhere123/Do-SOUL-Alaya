import { expect, it, vi } from "vitest";
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

type DependencyReader = NonNullable<SourceIndexQueryRepository["readHostDependency"]>;
const dependency = (id: string): HostSourceDependency => ({ source_id: id, root_id: id, source_version: "1",
  content_digest: `sha256:${"d".repeat(64)}`, occurrence_id: "message" });
const source = (id: string) => sourceIndexTarget({ kind: "source_evidence", workspace_id: "workspace",
  root_kind: "source_record", root_id: id, source_version: "1", content_digest: dependency(id).content_digest,
  evidence_object_id: null }, id, 1);
const resources = (nativeBytes: number, work = 1) => ({
  work, native_bytes: nativeBytes, memory_bytes: 0, sql_internal_work: "unknown" as const
});
function ready(id: string, dependencies: readonly HostSourceDependency[], nativeBytes: number): ReturnType<DependencyReader> {
  const occurrence: HostOccurrence = { occurrence_id: "message", utf8_span: [0, 4], role: "user",
    channel: null, author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
    completeness: "complete", fidelity: "original_bytes", semantic_dependencies: dependencies };
  return { status: "ready", source: source(id), occurrence, text: "data", content_span: [0, 4],
    content_complete: true, resources: resources(nativeBytes), inventory: { contract: "host-occurrence-v1",
      issuer: { namespace: "fixture", workspace_id: "workspace", producer: "fixture", basis: "pinned_dataset" },
      occurrences: [occurrence] } };
}
const input = () => ({ target: source("root").target, span: [0, 4] as const, authorizedScopes: ["project"],
  byteLimit: 10, budget: { work_units: 1_000_000, memory_bytes: 16_000_000 } });
const deliveredA = () => ({ reference: dependency("a"), status: "delivered", content: "data",
  utf8_span: [0, 4], content_span: [0, 4], dependencies: [] });

it("preserves earlier exposure and measured native bytes when a later dependency read throws", () => {
  const readHostDependency = vi.fn<DependencyReader>((_workspace, reference) => {
    if (reference.root_id === "root") return ready("root", [dependency("a"), dependency("b")], 5);
    if (reference.root_id === "a") return ready("a", [], 7);
    throw new Error("later native read failed");
  });
  const result = readSourceDependencyDelivery({ readHostDependency }, input());
  expect(result.exposure).toStrictEqual({ status: "partial",
    roots: [{ occurrence_id: "message", utf8_span: [0, 4], dependencies: [dependency("a"), dependency("b")] }],
    prerequisites: [deliveredA(), { status: "invalid" }] });
  expect(result.resources.native_bytes).toBe(12);
  expect(readHostDependency.mock.calls.map(call => call[1].root_id)).toEqual(["root", "a", "b"]);
  expect(readHostDependency.mock.calls.map(call => call[5])).toEqual([
    undefined, { byte_limit: 10, metadata_only: false }, { byte_limit: 6, metadata_only: false }
  ]);
  expect(readHostDependency.mock.calls[1]![4]).toBe(readHostDependency.mock.calls[0]![4]);
  expect(readHostDependency.mock.calls[2]![4]).toBe(readHostDependency.mock.calls[0]![4]);
});

it("accounts returned native bytes before a failed charge without delivering the uncharged dependency", () => {
  const readHostDependency = vi.fn<DependencyReader>((_workspace, reference) => {
    if (reference.root_id === "root") return ready("root", [dependency("a"), dependency("b")], 5);
    if (reference.root_id === "a") return ready("a", [], 7);
    return { ...ready("b", [], 11), resources: resources(11, 1_000_001) };
  });
  const result = readSourceDependencyDelivery({ readHostDependency }, input());
  expect(result.exposure.status).toBe("partial");
  expect(result.exposure.prerequisites).toStrictEqual([deliveredA(), { status: "resource_limited" }]);
  expect(result.resources.native_bytes).toBe(23);
  expect(readHostDependency).toHaveBeenCalledTimes(3);
});

it("rejects a continuation outside its delivered interval before any prerequisite read", () => {
  const readHostDependency = vi.fn<DependencyReader>(() => ready("root", [dependency("a")], 5));
  const result = readSourceDependencyDelivery({ readHostDependency }, { ...input(), continuation: {
    reference: dependency("a"), source_occurrence_id: "message", source_span: [1, 4], start_offset: 0
  } });
  expect(result.exposure).toStrictEqual({ status: "partial", roots: [], prerequisites: [] });
  expect(result.resources.native_bytes).toBe(5);
  expect(readHostDependency).toHaveBeenCalledTimes(1);
});

it("uses metadata-only traversal for an unbound continuation and reports its missing dependency", () => {
  const readHostDependency = vi.fn<DependencyReader>((_workspace, reference) =>
    ready(reference.root_id, reference.root_id === "root" ? [dependency("a"), dependency("b")] : [], 5));
  const result = readSourceDependencyDelivery({ readHostDependency }, { ...input(), continuation: {
    reference: dependency("not-declared"), source_occurrence_id: "message", source_span: [0, 4], start_offset: 2
  } });
  expect(result.exposure).toStrictEqual({ status: "partial",
    roots: [{ occurrence_id: "message", utf8_span: [0, 4], previously_delivered: true,
      dependencies: [dependency("a"), dependency("b")] }],
    prerequisites: [{ status: "invalid" }] });
  expect(readHostDependency.mock.calls.map(call => call[5])).toEqual([
    undefined, { byte_limit: 10, metadata_only: true }, { byte_limit: 10, metadata_only: true }
  ]);
});

it("preserves unknown root absence without fabricating a prerequisite failure", () => {
  const readHostDependency = vi.fn<DependencyReader>(() => ({
    status: "unknown", reason: "no captured host inventory", resources: resources(5)
  }));
  expect(readSourceDependencyDelivery({ readHostDependency }, input())).toStrictEqual({
    exposure: { status: "unknown", roots: [], prerequisites: [] },
    resources: resources(5)
  });
});
