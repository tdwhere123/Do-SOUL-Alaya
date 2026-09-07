import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type InformationIndex,
  type QueryProgram,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  encodeRecallResult,
  runConditionalFieldRecall,
  toSourceObserverRow,
  type ObserverReaders
} from "../../../recall/recall-service.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { projectFieldDelta } from "../../../recall/conditional-field/engine/field-engine.js";
import { projectAcceptingIndex } from "../../../recall/conditional-field/index/project-accepting-index.js";
import {
  assessUnknownCause,
  observeField,
  rolesFrom,
  type ObserveFieldInput
} from "../../../recall/runtime/conditional-field-observe.js";
import {
  INAPPLICABLE_KIND,
  MEM,
  NOW,
  WS,
  openSourceSlice
} from "../conditional-field/vertical/source-slice.js";
import { productStateId, type EnumeratedField } from "./enumerate-simple-paths.js";
import {
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget
} from "./finite-worlds.js";

export type SourceSlice = Awaited<ReturnType<typeof openSourceSlice>>;

export const SHORT_BY_MEM: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(MEM).map(([short, objectId]) => [objectId, short]))
);

export async function openBoundSlice(register: (database: StorageDatabase) => void, filename?: string) {
  return filename === undefined
    ? openSourceSlice(register)
    : openSourceSlice(register, filename);
}

export function readersFor(slice: SourceSlice): ObserverReaders {
  const kindsSql = slice.database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      return (kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[])
        .map((row) => row.kind);
    },
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
  };
}

export type NativeCounters = {
  nativeVisits: number;
  bytesRead: number;
  lexicalCalls: number;
  sourceCalls: number;
};

export function countingReaders(slice: SourceSlice): {
  readonly readers: ObserverReaders;
  readonly counters: NativeCounters;
} {
  const inner = readersFor(slice);
  const counters: NativeCounters = { nativeVisits: 0, bytesRead: 0, lexicalCalls: 0, sourceCalls: 0 };
  return {
    counters,
    readers: {
      ...inner,
      lexical: (input) => {
        counters.lexicalCalls += 1;
        const page = inner.lexical!(input);
        counters.nativeVisits += page.nativeVisits;
        counters.bytesRead += page.bytesRead;
        return page;
      },
      source: (input) => {
        counters.sourceCalls += 1;
        const page = inner.source!(input);
        counters.bytesRead += page.bytesRead;
        return page;
      },
      relation: (input) => {
        const page = inner.relation!(input);
        counters.nativeVisits += page.nativeVisits;
        counters.bytesRead += page.bytesRead;
        return page;
      }
    }
  };
}

export function produceField(
  slice: SourceSlice,
  input: Readonly<{
    readonly query_text?: string;
    readonly budget?: RequestBudget;
    readonly readers?: ObserverReaders;
    readonly authorized_scopes?: readonly string[];
    readonly cancelled?: boolean;
  }> = {}
) {
  const budget = input.budget ?? defaultBudget();
  const interpretation = compileConditionalFieldQuery({
    source: "ordinary",
    text: input.query_text ?? "yesterday failed deployment",
    snapshot_id: SNAPSHOT_ID,
    budget,
    interpretation_clock: INTERPRETATION_CLOCK
  });
  const observeInput: ObserveFieldInput = {
    workspace_id: WS,
    query_text: input.query_text ?? "yesterday failed deployment",
    budget,
    as_of: INTERPRETATION_CLOCK,
    readers: input.readers ?? readersFor(slice),
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled })
  };
  if (interpretation.status === "resource_rejected" || interpretation.status === "malformed"
    || interpretation.status === "unsupported") {
    return { interpretation, field: observeField(interpretation, observeInput), observeInput };
  }
  const field = assessUnknownCause(observeField(interpretation, observeInput), observeInput);
  return { interpretation, field, observeInput };
}

export function runRecall(
  slice: SourceSlice,
  input: Readonly<{
    readonly query_text?: string;
    readonly budget?: RequestBudget;
    readonly continuation?: InformationIndex["continuation"];
    readonly cancelled?: boolean;
    readonly authorized_scopes?: readonly string[];
    readonly interpretation_clock?: string;
    readonly as_of?: string;
    readonly readers?: ObserverReaders;
    readonly snapshot_id?: string;
  }> = {}
): InformationIndex {
  const clock = input.interpretation_clock ?? INTERPRETATION_CLOCK;
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: input.query_text ?? "yesterday failed deployment",
    budget: input.budget ?? defaultBudget(),
    snapshot_id: input.snapshot_id ?? SNAPSHOT_ID,
    interpretation_clock: clock,
    as_of: input.as_of ?? clock,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: input.readers ?? readersFor(slice),
    continuation: input.continuation ?? null,
    cancelled: input.cancelled === true,
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes })
  });
}

export function observeProgram(
  slice: SourceSlice,
  program: QueryProgram,
  input: Partial<ObserveFieldInput> & { readonly query_text?: string } = {}
) {
  const budget = input.budget ?? defaultBudget();
  const interpretation = compileConditionalFieldQuery({
    source: "typed",
    program,
    snapshot_id: SNAPSHOT_ID,
    budget,
    interpretation_clock: INTERPRETATION_CLOCK
  });
  const observeInput: ObserveFieldInput = {
    workspace_id: WS,
    query_text: input.query_text ?? "seed",
    budget,
    as_of: input.as_of ?? INTERPRETATION_CLOCK,
    readers: input.readers ?? readersFor(slice),
    ...(input.authorized_scopes === undefined ? {} : { authorized_scopes: input.authorized_scopes }),
    ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled })
  };
  const field = observeField(interpretation, observeInput);
  const assessed = assessUnknownCause(field, observeInput);
  return { interpretation, field: assessed, observeInput };
}

export function indexFromObserved(
  observed: ReturnType<typeof observeProgram>
): InformationIndex {
  const { interpretation, field, observeInput } = observed;
  const delta = projectFieldDelta(field);
  const snapshot = field.binding.kind === "bound"
    ? field.binding.snapshot
    : {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      snapshot_id: field.snapshot_id,
      query_id: field.query_id,
      seeds: field.seeds,
      values: delta.accepted_states,
      retained_transitions: field.transitions,
      facets: field.facets
    };
  return projectAcceptingIndex({
    snapshot,
    view: interpretation.view,
    query_id: interpretation.query_id,
    snapshot_id: interpretation.snapshot_id,
    result_version: "v1",
    budget: observeInput.budget,
    roles: rolesFrom(field),
    claims: field.claims,
    support: field.support,
    expires_at: "2099-01-01T00:00:00.000Z",
    as_of: observeInput.as_of,
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: field.closure.observation },
      open_regions: field.residuals
    },
    resume_cursors: field.resume_cursors,
    interpretation_status: interpretation.status === "resolved"
      || interpretation.status === "partial"
      || interpretation.status === "hypotheses"
      ? undefined
      : interpretation.status
  });
}

export function enumeratedFromField(state: ReturnType<typeof observeField>): EnumeratedField {
  if (state.binding.kind !== "bound") {
    return { kind: "unsupported", reason: state.binding.kind, values: new Map(), accepting: [], witnesses: [] };
  }
  const accepting = state.binding.snapshot.values.map((value) => ({
    ...value,
    state: {
      ...value.state,
      object_id: SHORT_BY_MEM[value.state.object_id] ?? value.state.object_id
    }
  }));
  const values = new Map<string, number>();
  for (const value of accepting) {
    const id = productStateId(value.state);
    values.set(id, Math.max(values.get(id) ?? 0, value.milligrades));
  }
  return { kind: "enumerated", values, accepting, witnesses: [] };
}

export function encodedRecall(index: InformationIndex, previews?: ReadonlyMap<string, string>) {
  return encodeRecallResult(index, previews ?? new Map());
}

export async function plantDeployment(slice: SourceSlice): Promise<void> {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.s, "shared routing service for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.h, "prior same-service failure last month", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.u, "unrelated picnic menu", MemoryDimension.FACT);
  stamp(slice, MEM.r, YESTERDAY_INSTANT);
  stamp(slice, MEM.l, YESTERDAY_INSTANT);
  stamp(slice, MEM.c, LAST_WEEK_INSTANT);
  stamp(slice, MEM.s, LAST_WEEK_INSTANT);
  stamp(slice, MEM.h, LAST_WEEK_INSTANT);
  stamp(slice, MEM.u, LAST_WEEK_INSTANT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    ["assert-r-l", MEM.r, MEM.l, "observed_log"],
    ["assert-l-c", MEM.l, MEM.c, "config_via_log"],
    ["assert-r-c", MEM.r, MEM.c, "config_direct"],
    ["assert-r-s", MEM.r, MEM.s, "uses_service"],
    ["assert-s-h", MEM.s, MEM.h, "service_history"],
    ["assert-r-u", MEM.r, MEM.u, INAPPLICABLE_KIND]
  ] as const;
  for (const [index, [assertionId, sourceId, targetId, relationKind]] of edges.entries()) {
    await slice.admitRelation({
      evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 201).padStart(12, "0")}`,
      assertionId,
      sourceId,
      targetId,
      resultObjectId: targetId,
      relationKind,
      validity: open,
      gist: relationKind
    });
  }
}

export function stamp(slice: SourceSlice, objectId: string, instant: string): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET created_at = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}

export function tombstone(slice: SourceSlice, objectId: string): void {
  const updateWithinTransaction = slice.memoryEntryRepo.updateWithinTransaction;
  if (updateWithinTransaction === undefined) {
    throw new Error("memory update transaction port is required for tombstone");
  }
  updateWithinTransaction.call(slice.memoryEntryRepo, objectId, {
    retention_state: "tombstoned",
    updated_at: NOW
  }, { beforeUpdate: () => undefined, afterUpdate: () => undefined }, WS);
  slice.database.connection.prepare(
    "UPDATE memory_entries SET lifecycle_state = ? WHERE object_id = ?"
  ).run("tombstone", objectId);
}

export function setScope(slice: SourceSlice, objectId: string, scopeClass: string): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET scope_class = ? WHERE object_id = ?"
  ).run(scopeClass, objectId);
}

export function setContent(slice: SourceSlice, objectId: string, content: string): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET content = ?, updated_at = ? WHERE object_id = ?"
  ).run(content, NOW, objectId);
}

export async function plantNeedles(slice: SourceSlice, count: number, start = 1): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(start + index).padStart(12, "0")}`
  );
  for (const [index, objectId] of ids.entries()) {
    await slice.writeMemory(objectId, `needle item ${String(index + 1)}`, MemoryDimension.FACT);
  }
  return ids;
}
