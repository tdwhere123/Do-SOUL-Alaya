import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import sidecar from "./semver-surface.sidecar.json" with { type: "json" };
import * as AppConfig from "../../config/app-config.js";
import * as CandidateMemorySignal from "../../signals/candidate-memory-signal.js";
import * as SchemaPrimitives from "../../shared/schema-primitives.js";
import * as BudgetEvents from "../../events/budget.js";
import * as ComputeRecallGardenEvents from "../../events/compute-recall-garden.js";
import * as EventLogOrphanEvents from "../../events/event-log-orphan.js";
import * as FileApprovalEvents from "../../events/file-approval.js";
import * as GardenEvents from "../../events/garden.js";
import * as GraphAuditorEvents from "../../events/graph-auditor.js";
import * as GreenGovernanceEvents from "../../events/green-governance.js";
import * as MemoryGovernanceEvents from "../../events/memory-governance.js";
import * as MessageDeltaEvents from "../../events/message-delta.js";
import * as ObligationTrustNarrativeEvents from "../../events/obligation-trust-narrative.js";
import * as ProjectMappingEvents from "../../events/project-mapping.js";
import * as RecallContextEvents from "../../events/recall-context.js";
import * as RuntimeGovernanceEvents from "../../events/runtime-governance.js";
import * as SignalEvents from "../../events/signal.js";
import * as SlotEvents from "../../events/slot.js";
import * as SurfaceEvents from "../../events/surface.js";
import * as ToolWorkerEvents from "../../events/tool-worker.js";
import * as WorkerRuntimeEvents from "../../events/worker-runtime.js";
import * as WorkspaceRunEvents from "../../events/workspace-run.js";
import * as McpTypes from "../../soul/mcp-types.js";
import * as BudgetSnapshot from "../../soul/budget-snapshot.js";
import * as EdgeProposal from "../../soul/edge-proposal.js";
import * as MemoryEntry from "../../soul/memory-entry.js";
import * as MemoryGraph from "../../soul/memory-graph.js";
import * as ObjectKind from "../../soul/object-kind.js";
import * as Proposal from "../../soul/proposal.js";
import * as RecallCandidate from "../../soul/recall-candidate.js";
import * as RecallPolicy from "../../soul/recall-policy.js";

type ModuleExports = Record<string, unknown>;

interface SchemaModule {
  readonly module: string;
  readonly exports: ModuleExports;
}

interface NamedSchema {
  readonly module: string;
  readonly name: string;
}

interface SchemaDescriptor {
  readonly keys: readonly string[];
  readonly signatureHash: string;
  readonly metadata: string | null;
}

const mcpSchemaModules: readonly SchemaModule[] = [
  { module: "packages/protocol/src/soul/mcp-types.ts", exports: McpTypes },
  { module: "packages/protocol/src/signals/candidate-memory-signal.ts", exports: CandidateMemorySignal },
  { module: "packages/protocol/src/shared/schema-primitives.ts", exports: SchemaPrimitives },
  { module: "packages/protocol/src/soul/budget-snapshot.ts", exports: BudgetSnapshot },
  { module: "packages/protocol/src/soul/edge-proposal.ts", exports: EdgeProposal },
  { module: "packages/protocol/src/soul/memory-entry.ts", exports: MemoryEntry },
  { module: "packages/protocol/src/soul/memory-graph.ts", exports: MemoryGraph },
  { module: "packages/protocol/src/soul/object-kind.ts", exports: ObjectKind },
  { module: "packages/protocol/src/soul/proposal.ts", exports: Proposal },
  { module: "packages/protocol/src/soul/recall-candidate.ts", exports: RecallCandidate },
  { module: "packages/protocol/src/soul/recall-policy.ts", exports: RecallPolicy }
];

const eventSchemaModules: readonly SchemaModule[] = [
  { module: "packages/protocol/src/events/budget.ts", exports: BudgetEvents },
  { module: "packages/protocol/src/events/compute-recall-garden.ts", exports: ComputeRecallGardenEvents },
  { module: "packages/protocol/src/events/event-log-orphan.ts", exports: EventLogOrphanEvents },
  { module: "packages/protocol/src/events/file-approval.ts", exports: FileApprovalEvents },
  { module: "packages/protocol/src/events/garden.ts", exports: GardenEvents },
  { module: "packages/protocol/src/events/graph-auditor.ts", exports: GraphAuditorEvents },
  { module: "packages/protocol/src/events/green-governance.ts", exports: GreenGovernanceEvents },
  { module: "packages/protocol/src/events/memory-governance.ts", exports: MemoryGovernanceEvents },
  { module: "packages/protocol/src/events/message-delta.ts", exports: MessageDeltaEvents },
  { module: "packages/protocol/src/events/obligation-trust-narrative.ts", exports: ObligationTrustNarrativeEvents },
  { module: "packages/protocol/src/events/project-mapping.ts", exports: ProjectMappingEvents },
  { module: "packages/protocol/src/events/recall-context.ts", exports: RecallContextEvents },
  { module: "packages/protocol/src/events/runtime-governance.ts", exports: RuntimeGovernanceEvents },
  { module: "packages/protocol/src/events/signal.ts", exports: SignalEvents },
  { module: "packages/protocol/src/events/slot.ts", exports: SlotEvents },
  { module: "packages/protocol/src/events/surface.ts", exports: SurfaceEvents },
  { module: "packages/protocol/src/events/tool-worker.ts", exports: ToolWorkerEvents },
  { module: "packages/protocol/src/events/worker-runtime.ts", exports: WorkerRuntimeEvents },
  { module: "packages/protocol/src/events/workspace-run.ts", exports: WorkspaceRunEvents }
];

const wrapperTypeNames = new Set([
  "catch",
  "default",
  "nonoptional",
  "nullable",
  "optional",
  "pipe",
  "prefault",
  "readonly"
]);

describe("semver-surface", () => {
  it("snapshots the v0.2 public MCP, EventLog, and runtime config surface", () => {
    const mcpSurface = computeMcpSurface();

    expect(mcpSurface.reachableModules).toEqual(
      expect.arrayContaining([
        "packages/protocol/src/signals/candidate-memory-signal.ts",
        "packages/protocol/src/shared/schema-primitives.ts",
        "packages/protocol/src/soul/edge-proposal.ts",
        "packages/protocol/src/soul/mcp-types.ts",
        "packages/protocol/src/soul/memory-entry.ts",
        "packages/protocol/src/soul/memory-graph.ts",
        "packages/protocol/src/soul/object-kind.ts",
        "packages/protocol/src/soul/proposal.ts",
        "packages/protocol/src/soul/recall-candidate.ts"
      ])
    );

    expect(computeSurfaceSource()).toMatchSnapshot();
  });

  // A surface change with no package.json version bump must FAIL. The sidecar
  // pins {version, surfaceHash}; regenerating the snapshot alone no longer
  // smuggles a breaking surface change through CI.
  it("requires a version bump when the public protocol surface changes", () => {
    const currentHash = sha256(computeSurfaceSource());
    const currentVersion = readPackageVersion();
    if (currentHash === sidecar.surfaceHash) {
      expect(currentVersion).toBe(sidecar.version);
      return;
    }
    expect(
      currentVersion,
      `The public protocol surface changed (hash ${sidecar.surfaceHash} -> ${currentHash}). ` +
        `Bump packages/protocol/package.json "version" and update ` +
        `semver-surface.sidecar.json to { "version": "${currentVersion}", "surfaceHash": "${currentHash}" }.`
    ).not.toBe(sidecar.version);
  });
});

function computeMcpSurface(): ReturnType<typeof collectMcpSurface> {
  const schemaRegistry = createSchemaRegistry([...mcpSchemaModules, ...eventSchemaModules, {
    module: "packages/protocol/src/config/app-config.ts",
    exports: AppConfig
  }]);
  return collectMcpSurface(schemaRegistry);
}

function computeSurfaceSource(): string {
  return formatSnapshotLines({
    mcp: computeMcpSurface(),
    eventPayloadKeys: collectPayloadSchemaKeys(eventSchemaModules),
    runtimeConfigKeys: collectRuntimeConfigKeys()
  }).join("\n");
}

function readPackageVersion(): string {
  const pkgUrl = new URL("../../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { readonly version: string };
  return pkg.version;
}

function collectMcpSurface(
  schemaRegistry: ReadonlyMap<z.ZodTypeAny, readonly NamedSchema[]>
): Readonly<{
  readonly reachableModules: readonly string[];
  readonly reachableSchemas: readonly Readonly<{
    readonly module: string;
    readonly schema: string;
  } & SchemaDescriptor>[];
}> {
  const roots = collectMcpRootSchemas();
  const reachable = new Map<string, { readonly module: string; readonly schema: string } & SchemaDescriptor>();
  const visited = new WeakSet<z.ZodTypeAny>();

  for (const root of roots) {
    visitSchema(root.schema, schemaRegistry, reachable, visited);
  }

  const reachableSchemas = [...reachable.values()].sort(compareByModuleThenSchema);

  return Object.freeze({
    reachableModules: Object.freeze([...new Set(reachableSchemas.map(({ module }) => module))].sort()),
    reachableSchemas: Object.freeze(reachableSchemas.map((entry) => Object.freeze(entry)))
  });
}

function collectMcpRootSchemas(): readonly Readonly<{ readonly name: string; readonly schema: z.ZodTypeAny }>[] {
  return Object.freeze(
    Object.entries(McpTypes)
      .filter(([name, value]) => /^(Soul|Garden|MemorySearch).*Schema$/.test(name) && isZodSchema(value))
      // isZodSchema narrows in the filter predicate but the guard does not flow
      // through tuple destructuring into the mapped element type.
      .map(([name, schema]) => Object.freeze({ name, schema: schema as z.ZodTypeAny }))
      .sort((left, right) => left.name.localeCompare(right.name))
  );
}

function collectPayloadSchemaKeys(
  modules: readonly SchemaModule[]
): readonly Readonly<{ readonly module: string; readonly schema: string } & SchemaDescriptor>[] {
  return Object.freeze(
    modules
      .flatMap(({ module, exports }) =>
        Object.entries(exports)
          .filter(([name, value]) => name.endsWith("PayloadSchema") && isZodSchema(value))
          // isZodSchema narrows in the filter predicate but the guard does not flow
          // through tuple destructuring into the mapped element type.
          .map(([schema, value]) => Object.freeze({ module, schema, ...describeSchema(value as z.ZodTypeAny) }))
      )
      .sort(compareByModuleThenSchema)
  );
}

function collectRuntimeConfigKeys(): readonly Readonly<{ readonly schema: string } & SchemaDescriptor>[] {
  return Object.freeze(
    Object.entries(AppConfig)
      .filter(([name, value]) => name.endsWith("ConfigSchema") && isZodSchema(value))
      // isZodSchema narrows in the filter predicate but the guard does not flow
      // through tuple destructuring into the mapped element type.
      .map(([schema, value]) => Object.freeze({ schema, ...describeSchema(value as z.ZodTypeAny) }))
      .sort((left, right) => left.schema.localeCompare(right.schema))
  );
}

function createSchemaRegistry(modules: readonly SchemaModule[]): ReadonlyMap<z.ZodTypeAny, readonly NamedSchema[]> {
  const registry = new Map<z.ZodTypeAny, NamedSchema[]>();

  for (const { module, exports } of modules) {
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith("Schema") || !isZodSchema(value)) {
        continue;
      }

      const entries = registry.get(value) ?? [];
      entries.push(Object.freeze({ module, name }));
      registry.set(value, entries);
    }
  }

  return registry;
}

function visitSchema(
  schema: z.ZodTypeAny,
  schemaRegistry: ReadonlyMap<z.ZodTypeAny, readonly NamedSchema[]>,
  reachable: Map<string, { readonly module: string; readonly schema: string } & SchemaDescriptor>,
  visited: WeakSet<z.ZodTypeAny>
): void {
  if (visited.has(schema)) {
    return;
  }
  visited.add(schema);

  for (const named of findNamedSchemas(schema, schemaRegistry)) {
    const key = `${named.module}:${named.name}`;
    if (!reachable.has(key)) {
      reachable.set(key, Object.freeze({
        module: named.module,
        schema: named.name,
        ...describeSchema(schema)
      }));
    }
  }

  const def = readDef(schema);
  switch (def.type) {
    case "object":
      for (const child of Object.values(readObjectShape(schema))) {
        visitSchema(child, schemaRegistry, reachable, visited);
      }
      return;
    case "array":
      visitUnknownSchema(def.element, schemaRegistry, reachable, visited);
      return;
    case "tuple":
      for (const child of readUnknownSchemaArray(def.items)) {
        visitSchema(child, schemaRegistry, reachable, visited);
      }
      visitUnknownSchema(def.rest, schemaRegistry, reachable, visited);
      return;
    case "union":
      for (const child of readUnknownSchemaArray(def.options)) {
        visitSchema(child, schemaRegistry, reachable, visited);
      }
      return;
    case "intersection":
      visitUnknownSchema(def.left, schemaRegistry, reachable, visited);
      visitUnknownSchema(def.right, schemaRegistry, reachable, visited);
      return;
    case "record":
      visitUnknownSchema(def.keyType, schemaRegistry, reachable, visited);
      visitUnknownSchema(def.valueType, schemaRegistry, reachable, visited);
      return;
    case "map":
      visitUnknownSchema(def.keyType, schemaRegistry, reachable, visited);
      visitUnknownSchema(def.valueType, schemaRegistry, reachable, visited);
      return;
    case "set":
      visitUnknownSchema(def.valueType, schemaRegistry, reachable, visited);
      return;
    case "lazy":
      if (typeof def.getter === "function") {
        visitUnknownSchema(def.getter(), schemaRegistry, reachable, visited);
      }
      return;
    default:
      if (wrapperTypeNames.has(def.type)) {
        visitUnknownSchema(readWrappedInnerSchema(def), schemaRegistry, reachable, visited);
      }
  }
}

function findNamedSchemas(
  schema: z.ZodTypeAny,
  schemaRegistry: ReadonlyMap<z.ZodTypeAny, readonly NamedSchema[]>
): readonly NamedSchema[] {
  const entries = schemaRegistry.get(schema);
  if (entries !== undefined) {
    return entries;
  }

  const unwrapped = unwrapSchema(schema);
  return schemaRegistry.get(unwrapped) ?? [];
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  const seen = new WeakSet<z.ZodTypeAny>();

  while (!seen.has(current)) {
    seen.add(current);
    const def = readDef(current);
    if (!wrapperTypeNames.has(def.type)) {
      return current;
    }

    const inner = readWrappedInnerSchema(def);
    if (!isZodSchema(inner)) {
      return current;
    }
    current = inner;
  }

  return current;
}

function getObjectKeys(schema: z.ZodTypeAny): readonly string[] {
  const unwrapped = unwrapSchema(schema);
  if (readDef(unwrapped).type !== "object") {
    return Object.freeze([]);
  }

  return Object.freeze(Object.keys(readObjectShape(unwrapped)).sort());
}

function describeSchema(schema: z.ZodTypeAny): SchemaDescriptor {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
    cycles: "ref"
  });
  return Object.freeze({
    keys: getObjectKeys(schema),
    signatureHash: sha256(stableStringify(jsonSchema)).slice(0, 7),
    metadata: getSchemaMetadata(schema)
  });
}

function getSchemaMetadata(schema: z.ZodTypeAny): string | null {
  const def = readDef(unwrapSchema(schema));
  if (def.type === "enum") {
    return `enum=${readStringArray(Object.values(def.entries as Record<string, unknown>)).join("|")}`;
  }
  if (def.type === "literal") {
    const values = def.values;
    return `literal=${JSON.stringify(Array.isArray(values) ? values[0] : values)}`;
  }
  return null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${key}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readObjectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const shape = readDef(schema).shape;
  return (typeof shape === "function" ? shape() : shape) as Record<string, z.ZodTypeAny>;
}

function readWrappedInnerSchema(def: Record<string, unknown>): unknown {
  return def.innerType ?? def.schema ?? def.in ?? def.out;
}

function visitUnknownSchema(
  value: unknown,
  schemaRegistry: ReadonlyMap<z.ZodTypeAny, readonly NamedSchema[]>,
  reachable: Map<string, { readonly module: string; readonly schema: string } & SchemaDescriptor>,
  visited: WeakSet<z.ZodTypeAny>
): void {
  if (isZodSchema(value)) {
    visitSchema(value, schemaRegistry, reachable, visited);
  }
}

function readUnknownSchemaArray(value: unknown): readonly z.ZodTypeAny[] {
  return Array.isArray(value) ? value.filter(isZodSchema) : [];
}

function readDef(schema: z.ZodTypeAny): Record<string, unknown> & { readonly type: string } {
  return schema._def as unknown as Record<string, unknown> & { readonly type: string };
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    "safeParse" in value &&
    typeof (value as { readonly safeParse?: unknown }).safeParse === "function";
}

function compareByModuleThenSchema(
  left: Readonly<{ readonly module: string; readonly schema: string }>,
  right: Readonly<{ readonly module: string; readonly schema: string }>
): number {
  return left.module.localeCompare(right.module) || left.schema.localeCompare(right.schema);
}

function formatSnapshotLines(surface: Readonly<{
  readonly mcp: ReturnType<typeof collectMcpSurface>;
  readonly eventPayloadKeys: ReturnType<typeof collectPayloadSchemaKeys>;
  readonly runtimeConfigKeys: ReturnType<typeof collectRuntimeConfigKeys>;
}>): readonly string[] {
  return Object.freeze([
    "[mcp.reachableModules]",
    ...surface.mcp.reachableModules.map(shortModule),
    "[mcp.reachableSchemas]",
    ...surface.mcp.reachableSchemas.map((entry) =>
      formatSchemaSnapshotLine(shortModule(entry.module), entry.schema, entry)
    ),
    "[eventPayloadKeys]",
    ...surface.eventPayloadKeys.map((entry) =>
      formatSchemaSnapshotLine(shortModule(entry.module), entry.schema, entry)
    ),
    "[runtimeConfigKeys]",
    ...surface.runtimeConfigKeys.map((entry) =>
      formatSchemaSnapshotLine("protocol:config/app-config.ts", entry.schema, entry)
    )
  ]);
}

function formatSchemaSnapshotLine(
  module: string,
  schema: string,
  descriptor: SchemaDescriptor
): string {
  return `${module}#${schema}(${descriptor.keys.join(",")})#${descriptor.signatureHash}${descriptor.metadata === null ? "" : `|${descriptor.metadata}`}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortModule(module: string): string {
  return module
    .replace("packages/protocol/src/events/", "evt:")
    .replace("packages/protocol/src/soul/", "soul:")
    .replace("packages/protocol/src/", "protocol:");
}
