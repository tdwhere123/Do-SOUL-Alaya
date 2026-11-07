import { afterEach, expect, it } from "vitest";
import { sourceIndexTarget } from "@do-soul/alaya-protocol";
import { eraseSource, publishSource } from "./source-index-fixture.js";
import { QUERY_BUDGET, WORKSPACE, expectQueryResources, fixture, type Fixture } from "./source-index-query-fixture.js";
import { contextOf, publishMessages, publishStatement } from "./source-template-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  for (const environment of environments.splice(0)) environment.database.close();
});

function setup(withContext = false) {
  const environment = fixture(); environments.push(environment);
  const text = `${"earlier detail ".repeat(12)}I repaired the café hinge with a wrench.`;
  const input = publishMessages(environment, [{ role: "user", text },
    { role: "assistant", text: "A separate response." }], "source", WORKSPACE, "2026-09-08T00:00:00.000Z");
  const context = withContext ? publishMessages(environment, [{ role: "user", text: "Earlier context." }], "context") : undefined;
  const auxiliary = publishStatement(environment, input, "repair-statement", 1,
    { statement: { text: "Hinge repair.", relation: "reported event" } },
    context === undefined ? [] : [contextOf(context.record)]).source;
  const excerpt = "café hinge with a wrench";
  const start = Buffer.byteLength(`user: ${text.slice(0, text.indexOf(excerpt))}`);
  const span = { start_byte: start, end_byte: start + Buffer.byteLength(excerpt) };
  return { environment, input, auxiliary, context, span, excerpt };
}

it("binds the same raw UTF-8 excerpt after direct or auxiliary discovery", () => {
  const { environment, input, auxiliary, span, excerpt } = setup();
  expect(span.start_byte).toBeGreaterThan(auxiliary.body_bytes);
  expect(span.end_byte).toBeLessThan(auxiliary.auxiliary!.source_span[0]);
  expect(environment.index.admitQueryCandidate(auxiliary, null, QUERY_BUDGET).status).toBe("ready");
  const direct = environment.index.readTaskObservation(input.source, span, QUERY_BUDGET);
  expect(direct).toMatchObject({ status: "ready", text: excerpt, source_observed_at: "2026-09-08T00:00:00.000Z" });
  const viaStatement = environment.index.readTaskObservation(auxiliary, span, QUERY_BUDGET);
  expect(viaStatement.status, JSON.stringify(viaStatement)).toBe("ready");
  expect(viaStatement).toMatchObject({ text: excerpt, source_observed_at: "2026-09-08T00:00:00.000Z" });
});

it("charges the complete auxiliary admission and literal native excerpt read", () => {
  const { environment, auxiliary, span } = setup();
  const admission = environment.index.admitQueryCandidate(auxiliary, null, QUERY_BUDGET);
  expect(admission.status).toBe("ready");
  const bytes = span.end_byte - span.start_byte;
  const raw = environment.records.findByIdBounded(WORKSPACE, auxiliary.target.root_id, bytes, span.start_byte);
  expect(raw?.record?.source_body).toBe("café hinge with a wrench");
  const nativeBytes = raw!.nativeBytes + raw!.metadataBytes;
  const read = environment.index.readTaskObservation(auxiliary, span, QUERY_BUDGET);
  expect(read.status).toBe("ready");
  expect(read.resources).toEqual({ work: admission.resources.work + bytes + 5 + raw!.dependencyWork,
    memory_bytes: admission.resources.memory_bytes + bytes * 2 + nativeBytes,
    native_bytes: admission.resources.native_bytes + nativeBytes, sql_internal_work: "unknown" });
  expectQueryResources(read.resources);

  const budget = { work_units: admission.resources.work + bytes + 4, memory_bytes: QUERY_BUDGET.memory_bytes };
  const refused = environment.index.readTaskObservation(auxiliary, span, budget);
  expect(refused).toMatchObject({ status: "unknown", reason: "source_task_read_budget:source task excerpt" });
  expect(refused.resources).toEqual(admission.resources);
  expectQueryResources(refused.resources, budget);
  expect(environment.index.readTaskObservation(auxiliary, span, { work_units: 0, memory_bytes: 0 }))
    .toMatchObject({ status: "unknown", resources: { work: 0, memory_bytes: 0, native_bytes: 0 } });
});

it("refuses malformed UTF-8 boundaries and raw out-of-range excerpts without returning a partial quote", () => {
  const { environment, input, auxiliary, span } = setup();
  const cafe = span.start_byte;
  for (const invalid of [
    { start_byte: cafe + 4, end_byte: cafe + 6 }, // inside é
    { start_byte: cafe, end_byte: cafe + 4 }, // ends inside é
    { start_byte: input.source.body_bytes - 1, end_byte: input.source.body_bytes + 1 },
    { start_byte: input.source.body_bytes + 1, end_byte: input.source.body_bytes + 2 }
  ]) {
    const read = environment.index.readTaskObservation(auxiliary, invalid, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_task_incomplete" });
    expect(read).not.toHaveProperty("text");
    expect(read.resources.work).toBeGreaterThan(0);
    expect(read.resources.native_bytes).toBeGreaterThan(0);
    expectQueryResources(read.resources);
  }
  expect(environment.index.readTaskObservation(input.source,
    { start_byte: input.source.body_bytes - 1, end_byte: input.source.body_bytes + 1 }, QUERY_BUDGET))
    .toMatchObject({ status: "unknown", reason: "source_task_invalid_span" });
});

it("rejects tampered statement and raw identities even when their root keys are recomputed", () => {
  const { environment, auxiliary, span } = setup();
  const aux = auxiliary.auxiliary!;
  const altered = [
    sourceIndexTarget(auxiliary.target, auxiliary.source_id, auxiliary.body_bytes,
      { ...aux, artifact_digest: `sha256:${"a".repeat(64)}` }),
    sourceIndexTarget(auxiliary.target, auxiliary.source_id, auxiliary.body_bytes,
      { ...aux, key_digest: `sha256:${"b".repeat(64)}` }),
    sourceIndexTarget(auxiliary.target, auxiliary.source_id, auxiliary.body_bytes,
      { ...aux, source_span: [0, 1] }),
    sourceIndexTarget(auxiliary.target, auxiliary.source_id, auxiliary.body_bytes + 1, aux),
    sourceIndexTarget({ ...auxiliary.target, source_version: "wrong" }, auxiliary.source_id, auxiliary.body_bytes, aux),
    sourceIndexTarget({ ...auxiliary.target, content_digest: `sha256:${"c".repeat(64)}` }, auxiliary.source_id, auxiliary.body_bytes, aux),
    sourceIndexTarget({ ...auxiliary.target, workspace_id: "workspace-2" }, auxiliary.source_id, auxiliary.body_bytes, aux),
    sourceIndexTarget(auxiliary.target, "wrong-source", auxiliary.body_bytes, aux)
  ];
  for (const source of altered) {
    const read = environment.index.readTaskObservation(source, span, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_task_stale" });
    expect(read).not.toHaveProperty("text");
    expect(read.resources.work).toBeGreaterThan(0);
    expectQueryResources(read.resources);
  }
});

it("withdraws a stale auxiliary dependency without withdrawing the independent current raw source", () => {
  const { environment, input, auxiliary, context, span, excerpt } = setup(true);
  publishSource(environment, "Changed context.", context!.record.source_id,
    { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
  const refused = environment.index.readTaskObservation(auxiliary, span, QUERY_BUDGET);
  expect(refused).toMatchObject({ status: "unknown", reason: "source_task_stale" });
  expect(refused.resources.native_bytes).toBeGreaterThan(0);
  expect(environment.index.readTaskObservation(input.source, span, QUERY_BUDGET))
    .toMatchObject({ status: "ready", text: excerpt });
});

it.each(["replaced", "erased", "artifact withdrawn"])("refuses the %s binding after it was admitted", state => {
  const { environment, input, auxiliary, span } = setup();
  expect(environment.index.readTaskObservation(auxiliary, span, QUERY_BUDGET).status).toBe("ready");
  if (state === "replaced") publishSource(environment, "A newer version.", input.record.source_id,
    { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
  else if (state === "erased") eraseSource(environment, input.record.record_id);
  else environment.database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived' WHERE object_id=?")
    .run(auxiliary.auxiliary!.artifact_id);
  const read = environment.index.readTaskObservation(auxiliary, span, QUERY_BUDGET);
  expect(read).toMatchObject({ status: "unknown", reason: "source_task_stale" });
  expect(read).not.toHaveProperty("text");
  expect(read.resources.work).toBeGreaterThan(0);
  expectQueryResources(read.resources);
  if (state === "artifact withdrawn") expect(environment.index.readTaskObservation(input.source, span, QUERY_BUDGET).status).toBe("ready");
  else expect(environment.index.readTaskObservation(input.source, span, QUERY_BUDGET).status).toBe("unknown");
});
