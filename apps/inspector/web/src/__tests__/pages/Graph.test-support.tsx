import { act, render } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { setInspectorToken, setWorkspaceId } from "../../api";
import { ToastProvider } from "../../components/Toast";
import GraphPage from "../../pages/Graph";

const forceGraphMockState = vi.hoisted(() => ({
  distanceCalls: [] as number[][],
  strengthCalls: [] as number[][],
  reheatCount: 0,
  reset() {
    this.distanceCalls = [];
    this.strengthCalls = [];
    this.reheatCount = 0;
  }
}));

export function getForceGraphMockState(): typeof forceGraphMockState {
  return forceGraphMockState;
}

interface ForceGraphStubNode {
  id: string;
  label?: string;
  kind?: string;
  influence_count?: number;
  last_used_at?: string;
}

interface ForceGraphStubLink {
  id: string;
  strength_normalized?: number;
  weight?: number;
  last_reinforced_at?: string;
}

interface ForceGraphStubProps {
  graphData?: { nodes?: ForceGraphStubNode[]; links?: ForceGraphStubLink[] };
  nodeColor?: (node: ForceGraphStubNode) => string;
  nodeLabel?: (node: ForceGraphStubNode) => string;
  nodeVal?: (node: ForceGraphStubNode) => number;
  linkColor?: (link: ForceGraphStubLink) => string;
  linkWidth?: (link: ForceGraphStubLink) => number;
  linkDirectionalParticles?: (link: ForceGraphStubLink) => number;
  linkDirectionalParticleSpeed?: (link: ForceGraphStubLink) => number;
  onEngineTick?: () => void;
  onEngineStop?: () => void;
  cooldownTicks?: number;
  onNodeClick?: (node: ForceGraphStubNode, event?: MouseEvent) => void;
  onBackgroundClick?: () => void;
  width?: number;
  height?: number;
}

function createForceGraphHandle(links: readonly ForceGraphStubLink[]) {
  return {
    d3Force: (name: string) =>
      name === "link"
        ? {
            distance: (fn: (link: ForceGraphStubLink) => number) => {
              forceGraphMockState.distanceCalls.push(links.map((link) => fn(link)));
            },
            strength: (fn: (link: ForceGraphStubLink) => number) => {
              forceGraphMockState.strengthCalls.push(links.map((link) => fn(link)));
            }
          }
        : undefined,
    d3ReheatSimulation: () => {
      forceGraphMockState.reheatCount += 1;
    }
  };
}

vi.mock("react-force-graph-2d", () => {
  const Stub = forwardRef<unknown, ForceGraphStubProps>((props, ref) => {
    const nodes = props.graphData?.nodes ?? [];
    const links = props.graphData?.links ?? [];
    useImperativeHandle(ref, () => createForceGraphHandle(links), [links]);
    useEffect(() => {
      props.onEngineTick?.();
    }, [props]);
    return (
      <div
        data-testid="force-graph-2d"
        data-node-count={nodes.length}
        data-link-count={links.length}
        data-width={props.width}
        data-height={props.height}
      >
        {nodes.map((rawNode) => {
          const node = rawNode as { id: string; label?: string; kind?: string };
          return (
            <button
              key={node.id}
              data-testid={`fg-node-${node.id}`}
              data-color={props.nodeColor?.(node) ?? ""}
              data-label-text={props.nodeLabel?.(node) ?? ""}
              data-node-val={props.nodeVal?.(node) ?? ""}
              onClick={(event) => props.onNodeClick?.(node, event.nativeEvent)}
            >
              {node.label ?? node.id}
            </button>
          );
        })}
        {links.map((link) => (
          <div
            key={link.id}
            data-testid={`fg-link-${link.id}`}
            data-color={props.linkColor?.(link) ?? ""}
            data-width={props.linkWidth?.(link) ?? ""}
            data-particles={props.linkDirectionalParticles?.(link) ?? ""}
            data-particle-speed={props.linkDirectionalParticleSpeed?.(link) ?? ""}
          />
        ))}
        <button
          data-testid="fg-background"
          onClick={() => props.onBackgroundClick?.()}
        >
          background
        </button>
      </div>
    );
  });
  Stub.displayName = "ForceGraph2DStub";
  return { default: Stub };
});

vi.mock("react-force-graph-3d", () => {
  const Stub = forwardRef<unknown, ForceGraphStubProps>((props, ref) => {
    const links = props.graphData?.links ?? [];
    useImperativeHandle(ref, () => createForceGraphHandle(links), [links]);
    useEffect(() => {
      props.onEngineTick?.();
      props.onEngineStop?.();
    }, [props]);
    return (
      <div
        data-testid="force-graph-3d"
        data-node-count={(props.graphData?.nodes ?? []).length}
        data-link-count={links.length}
        data-cooldown-ticks={props.cooldownTicks}
      >
        {links.map((link) => (
          <div
            key={link.id}
            data-testid={`fg-3d-link-${link.id}`}
            data-width={props.linkWidth?.(link) ?? ""}
            data-particles={props.linkDirectionalParticles?.(link) ?? ""}
            data-particle-speed={props.linkDirectionalParticleSpeed?.(link) ?? ""}
          />
        ))}
      </div>
    );
  }) as unknown as (props: ForceGraphStubProps) => ReactElement;
  return { default: Stub };
});

export function stubWebgl(supported: boolean): void {
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown
  ) {
    if (contextId === "webgl" || contextId === "webgl2") {
      if (!supported) return null;
      let pendingClear: [number, number, number, number] = [0, 0, 0, 0];
      return {
        createProgram: () => ({}),
        deleteProgram: () => undefined,
        // The probe sets clearColor(0.4, 0.6, 0.8, 1.0) → 102/153/204/255.
        clearColor: (r: number, g: number, b: number, a: number) => {
          pendingClear = [
            Math.round(r * 255),
            Math.round(g * 255),
            Math.round(b * 255),
            Math.round(a * 255)
          ];
        },
        clear: () => undefined,
        readPixels: (
          _x: number,
          _y: number,
          _w: number,
          _h: number,
          _format: number,
          _type: number,
          buffer: Uint8Array
        ) => {
          buffer[0] = pendingClear[0];
          buffer[1] = pendingClear[1];
          buffer[2] = pendingClear[2];
          buffer[3] = pendingClear[3];
        },
        COLOR_BUFFER_BIT: 0x4000,
        RGBA: 0x1908,
        UNSIGNED_BYTE: 0x1401
      } as unknown as WebGLRenderingContext;
    }
    return realGetContext.call(this, contextId as "2d", options as never);
  });
}

// The Graph page now consumes the path_relations plane projection
// (SoulPathGraphContract / BuiltPathGraph). The fixture mirrors that shape:
// nodes carry {id, anchor, label, out_degree, in_degree} and edges carry the
// full PathRelation in `relation` plus the projected edge fields. node ids are
// authored as n1/n2/n3 so the existing fg-node-* / fg-link-* selectors hold.
// see also: apps/core-daemon/src/routes/path-graph.ts
//           packages/protocol/src/soul/graph.ts SoulPathGraphContract
export function makeFixtureRelation(input: {
  readonly pathId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly strength: number;
  readonly stabilityClass: "volatile" | "normal" | "stable" | "pinned";
  readonly lastReinforcedAt?: string;
}) {
  return {
    path_id: input.pathId,
    workspace_id: "ws-1",
    anchors: {
      source_anchor: { kind: "object", object_id: input.sourceObjectId },
      target_anchor: { kind: "object", object_id: input.targetObjectId }
    },
    constitution: { relation_kind: "supports", why_this_relation_exists: ["fixture"] },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: input.strength,
      direction_bias: "source_to_target",
      stability_class: input.stabilityClass,
      support_events_count: 1,
      contradiction_events_count: 0,
      ...(input.lastReinforcedAt === undefined
        ? {}
        : { last_reinforced_at: input.lastReinforcedAt })
    },
    lifecycle: { status: "active", retirement_rule: "default" },
    legitimacy: { evidence_basis: ["evidence-1"], governance_class: "recall_allowed" },
    created_at: "2026-05-05T01:00:00.000Z",
    updated_at: "2026-05-05T02:00:00.000Z"
  };
}

export const SAMPLE_GRAPH = {
  contract_version: 1,
  workspace_id: "ws-1",
  generated_at: "2026-05-05T03:00:00.000Z",
  nodes: [
    // n1 has total degree 3 (out 2 + in 1) so the influence-size assertion that
    // pins nodeInfluenceSize(influence_count: 3) still holds.
    { id: "n1", anchor: { kind: "object", object_id: "n1" }, label: "mem-alpha", out_degree: 2, in_degree: 1 },
    { id: "n2", anchor: { kind: "object", object_id: "n2" }, label: "mem-beta", out_degree: 1, in_degree: 1 },
    { id: "n3", anchor: { kind: "object", object_id: "n3" }, label: "scope-gamma", out_degree: 0, in_degree: 1 }
  ],
  edges: [
    {
      id: "e1",
      source_id: "n1",
      target_id: "n2",
      source_anchor: { kind: "object", object_id: "n1" },
      target_anchor: { kind: "object", object_id: "n2" },
      relation_kind: "supports",
      strength: 0.85,
      direction_bias: "source_to_target",
      stability_class: "stable",
      governance_class: "recall_allowed",
      effect_vector: {
        salience: 0.5,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      relation: makeFixtureRelation({
        pathId: "e1",
        sourceObjectId: "n1",
        targetObjectId: "n2",
        strength: 0.85,
        stabilityClass: "stable",
        lastReinforcedAt: new Date().toISOString()
      }),
      created_at: "2026-05-05T01:00:00.000Z",
      updated_at: "2026-05-05T02:00:00.000Z"
    },
    {
      id: "e2",
      source_id: "n2",
      target_id: "n3",
      source_anchor: { kind: "object", object_id: "n2" },
      target_anchor: { kind: "object", object_id: "n3" },
      relation_kind: "supports",
      strength: 0.2,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      governance_class: "recall_allowed",
      effect_vector: {
        salience: 0.5,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      relation: makeFixtureRelation({
        pathId: "e2",
        sourceObjectId: "n2",
        targetObjectId: "n3",
        strength: 0.2,
        stabilityClass: "volatile"
      }),
      created_at: "2026-05-05T01:00:00.000Z",
      updated_at: "2026-05-05T02:00:00.000Z"
    }
  ],
  topology: {
    total_nodes: 3,
    total_edges: 2,
    max_out_degree: 2,
    max_in_degree: 1,
    avg_degree: 2,
    strongly_connected_components: 3
  }
};

// Drives the large-graph 3D performance gate (>500 nodes) with a single
// recently-reinforced edge, in the path-graph contract shape.
export function makeLargePathGraph() {
  const nodes = Array.from({ length: 501 }, (_, index) => ({
    id: `n${index}`,
    anchor: { kind: "object", object_id: `n${index}` },
    label: `node-${index}`,
    out_degree: index === 0 ? 1 : 0,
    in_degree: index === 1 ? 1 : 0
  }));
  return {
    ...SAMPLE_GRAPH,
    nodes,
    edges: [
      {
        id: "large-link",
        source_id: "n0",
        target_id: "n1",
        source_anchor: { kind: "object", object_id: "n0" },
        target_anchor: { kind: "object", object_id: "n1" },
        relation_kind: "supports",
        strength: 0.9,
        direction_bias: "source_to_target",
        stability_class: "stable",
        governance_class: "recall_allowed",
        effect_vector: {
          salience: 0.5,
          recall_bias: 0.5,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        relation: makeFixtureRelation({
          pathId: "large-link",
          sourceObjectId: "n0",
          targetObjectId: "n1",
          strength: 0.9,
          stabilityClass: "stable",
          lastReinforcedAt: new Date().toISOString()
        }),
        created_at: "2026-05-05T01:00:00.000Z",
        updated_at: "2026-05-05T02:00:00.000Z"
      }
    ],
    topology: {
      total_nodes: nodes.length,
      total_edges: 1,
      max_out_degree: 1,
      max_in_degree: 1,
      avg_degree: 0.004,
      strongly_connected_components: nodes.length
    }
  };
}

// Three nodes joined by edges of distinct relation_kind families so the
// per-family edge palette can be asserted: supports (positive structural),
// contradicts (negative), recalls (positive associative). mapPathGraphEdge
// reads the projected top-level `relation_kind`, so only that field varies.
export function makeRelationKindGraph() {
  const buildEdge = (
    id: string,
    sourceId: string,
    targetId: string,
    relationKind: string
  ) => ({
    id,
    source_id: sourceId,
    target_id: targetId,
    source_anchor: { kind: "object", object_id: sourceId },
    target_anchor: { kind: "object", object_id: targetId },
    relation_kind: relationKind,
    strength: 0.6,
    direction_bias: "source_to_target",
    stability_class: "stable",
    governance_class: "recall_allowed",
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    relation: makeFixtureRelation({
      pathId: id,
      sourceObjectId: sourceId,
      targetObjectId: targetId,
      strength: 0.6,
      stabilityClass: "stable"
    }),
    created_at: "2026-05-05T01:00:00.000Z",
    updated_at: "2026-05-05T02:00:00.000Z"
  });
  return {
    ...SAMPLE_GRAPH,
    edges: [
      buildEdge("e-supports", "n1", "n2", "supports"),
      buildEdge("e-contradicts", "n2", "n3", "contradicts"),
      buildEdge("e-recalls", "n1", "n3", "recalls")
    ],
    topology: {
      total_nodes: 3,
      total_edges: 3,
      max_out_degree: 2,
      max_in_degree: 2,
      avg_degree: 2,
      strongly_connected_components: 1
    }
  };
}

export function renderGraphWithEnv() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GraphPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

export function createAnimationFrameDriver() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      callbacks.delete(id);
    })
  );
  return {
    async step(timestamp: number) {
      const queued = [...callbacks.values()];
      callbacks.clear();
      await act(async () => {
        for (const callback of queued) callback(timestamp);
      });
    }
  };
}
