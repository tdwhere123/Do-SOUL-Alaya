import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { forwardRef, useEffect, useImperativeHandle, type ReactElement } from "react";
import { ToastProvider } from "../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../api";
import {
  STABILITY_DASH,
  linkDistance,
  linkStrength,
  linkWidth,
  nodeInfluenceSize
} from "../utils/graph";
import GraphPage from "./Graph";

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

function stubWebgl(supported: boolean): void {
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

const SAMPLE_GRAPH = {
  workspace_id: "ws-1",
  nodes: [
    {
      id: "n1",
      kind: "memory",
      label: "mem-alpha",
      summary: "first",
      origin_kind: "user_memory",
      last_used_at: new Date().toISOString(),
      influence_count: 3
    },
    {
      id: "n2",
      kind: "memory",
      label: "mem-beta",
      summary: "second",
      origin_kind: "engineering_chunk",
      last_used_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString()
    },
    {
      id: "n3",
      kind: "scope",
      label: "scope-gamma",
      summary: "third",
      origin_kind: "system"
    }
  ],
  edges: [
    {
      id: "e1",
      kind: "references",
      source_id: "n1",
      target_id: "n2",
      strength_normalized: 0.85,
      stability_class: "stable",
      last_reinforced_at: new Date().toISOString()
    },
    {
      id: "e2",
      kind: "belongs_to",
      source_id: "n2",
      target_id: "n3",
      strength_normalized: 0.2,
      stability_class: "volatile"
    }
  ],
  truncated: false,
  node_total: 3,
  edge_total: 2
};

function renderGraphWithEnv() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <GraphPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

function createAnimationFrameDriver() {
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

describe("GraphPage (react-force-graph driven)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    forceGraphMockState.reset();
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    stubWebgl(true);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders graph data from the daemon success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: SAMPLE_GRAPH }), {
        status: 200
      })
    );
    renderGraphWithEnv();
    const stub = await screen.findByTestId("force-graph-2d");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/graph/ws-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-Alaya-Inspector-Token": "test-token" })
      })
    );
    expect(stub.getAttribute("data-node-count")).toBe("3");
    expect(stub.getAttribute("data-link-count")).toBe("2");
  });

  it("renders no-workspace alert and never fetches when workspaceId is null", async () => {
    setWorkspaceId(null);

    renderGraphWithEnv();

    expect(await screen.findByTestId("graph-no-workspace")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces returned-vs-total counts and the sampled badge", async () => {
    const sampled = {
      ...SAMPLE_GRAPH,
      truncated: true,
      node_total: 25,
      edge_total: 40
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(sampled), { status: 200 })
    );
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    expect(await screen.findByText(/3\/25 nodes/i)).toBeTruthy();
    expect(await screen.findByText(/2\/40 edges/i)).toBeTruthy();
    expect(await screen.findByText(/sampled/i)).toBeTruthy();
  });

  it("mounts the origin-kind legend so users can decode node colours", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    expect(screen.getByText(/user memory/i)).toBeTruthy();
    expect(screen.getByText(/engineering chunk/i)).toBeTruthy();
    expect(screen.getByText(/reviewed engineering/i)).toBeTruthy();
    expect(screen.getByText(/proposal pending/i)).toBeTruthy();
  });

  it("opens the detail drawer on node click", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByTestId("fg-node-n1"));
    // After click the label should appear at least twice — once in the stub
    // button and once inside the DetailDrawer header — so "all" is the right
    // query (findByText would throw on the multi-match).
    await waitFor(() => {
      const matches = screen.getAllByText("mem-alpha");
      expect(matches.length).toBeGreaterThan(1);
    });
  });

  it("toggles to the 3D component when the 3D button is clicked", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const callsBeforeToggle = forceGraphMockState.distanceCalls.length;
    const toggle3d = screen.getByRole("button", { name: /3D/i });
    await user.click(toggle3d);
    await waitFor(() => {
      expect(screen.getByTestId("force-graph-3d")).toBeTruthy();
      expect(screen.queryByTestId("force-graph-2d")).not.toBeTruthy();
    });
    await waitFor(() => {
      expect(forceGraphMockState.distanceCalls.length).toBeGreaterThan(callsBeforeToggle);
    });
    expect(forceGraphMockState.distanceCalls.at(-1)).toEqual([
      linkDistance(0.85),
      linkDistance(0.2)
    ]);
    expect(forceGraphMockState.strengthCalls.at(-1)).toEqual([
      0.1 + 0.9 * linkStrength(0.85),
      0.1 + 0.9 * linkStrength(0.2)
    ]);
  });

  it("locks 2D mode and disables the 3D toggle when WebGL is unavailable", async () => {
    stubWebgl(false);
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const toggle3d = screen.getByRole("button", { name: /3D/i }) as HTMLButtonElement;
    expect(toggle3d.disabled).toBe(true);
    expect(screen.getByText(/3D not available in this environment/i)).toBeTruthy();
  });

  it("pins node and edge visual encodings required by the graph plan", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");

    expect(screen.getByTestId("fg-node-n1").getAttribute("data-node-val")).toBe(
      String(nodeInfluenceSize({ id: "n1", kind: "memory", influence_count: 3 }) ** 2)
    );
    expect(screen.getByTestId("fg-link-e1").getAttribute("data-width")).toBe(
      String(linkWidth(0.85))
    );
    expect(linkDistance(0.9)).toBeCloseTo(80);
    expect(linkDistance(0.1)).toBeCloseTo(240);
    expect(linkWidth(undefined, 0.9)).toBeGreaterThan(linkWidth(undefined, 0.1));
    expect(STABILITY_DASH.volatile).toEqual([4, 3]);
  });

  it("uses legacy weight as the fallback for edge strength encoding", () => {
    expect(linkStrength(undefined, 0.9)).toBe(0.9);
    expect(linkDistance(undefined, 0.9)).toBeLessThan(linkDistance(undefined, 0.1));
    expect(linkWidth(undefined, 0.9)).toBeGreaterThan(linkWidth(undefined, 0.1));
    expect(linkStrength(undefined, undefined)).toBe(0.3);
  });

  it("includes influence and last-used metadata in node hover labels", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    const label = screen.getByTestId("fg-node-n1").getAttribute("data-label-text") ?? "";
    expect(label).toContain("mem-alpha");
    expect(label).toContain("influence: 3");
    expect(label).toContain("last used:");
  });

  it("focuses the one-hop subgraph shortcut on double click", async () => {
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    fireEvent.click(screen.getByTestId("fg-node-n1"), { detail: 1 });
    fireEvent.click(screen.getByTestId("fg-node-n1"), { detail: 2 });
    expect((screen.getByPlaceholderText(/probe label/i) as HTMLInputElement).value).toBe("n1");
  });

  it("uses the large-graph 3D performance gate", async () => {
    const nodes = Array.from({ length: 501 }, (_, index) => ({
      id: `n${index}`,
      kind: "memory",
      label: `node-${index}`,
      origin_kind: "system"
    }));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SAMPLE_GRAPH,
          nodes,
          edges: [
            {
              id: "large-link",
              kind: "references",
              source_id: "n0",
              target_id: "n1",
              strength_normalized: 0.9,
              last_reinforced_at: new Date().toISOString()
            }
          ],
          node_total: nodes.length,
          edge_total: 1
        }),
        { status: 200 }
      )
    );
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByRole("button", { name: /3D/i }));
    await screen.findByTestId("force-graph-3d");

    expect(screen.getByText(/large graph mode/i)).toBeTruthy();
    expect(screen.getByTestId("force-graph-3d").getAttribute("data-cooldown-ticks")).toBe("60");
    expect(screen.getByTestId("fg-3d-link-large-link").getAttribute("data-particles")).toBe("0");
  });

  it("clears the low-FPS warning after sustained recovered frame cadence", async () => {
    const raf = createAnimationFrameDriver();
    const nodes = Array.from({ length: 501 }, (_, index) => ({
      id: `n${index}`,
      kind: "memory",
      label: `node-${index}`,
      origin_kind: "system"
    }));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...SAMPLE_GRAPH,
          nodes,
          edges: [
            {
              id: "large-link",
              kind: "references",
              source_id: "n0",
              target_id: "n1",
              strength_normalized: 0.9,
              last_reinforced_at: new Date().toISOString()
            }
          ],
          node_total: nodes.length,
          edge_total: 1
        }),
        { status: 200 }
      )
    );
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.click(screen.getByRole("button", { name: /3D/i }));
    await screen.findByTestId("force-graph-3d");

    await raf.step(0);
    for (let i = 1; i <= 16; i += 1) await raf.step(i * 100);
    expect(screen.getByText(/low fps detected/i)).toBeTruthy();

    for (let i = 1; i <= 15; i += 1) await raf.step(1600 + i * 16);
    await waitFor(() => {
      expect(screen.queryByText(/low fps detected/i)).toBeNull();
    });
  });

  // Note: the full retire→already-pending toast flow is pinned daemon-side at
  // apps/core-daemon/src/__tests__/routes-proposals.test.ts ("dedupes a
  // repeated retire click" + "still creates a new proposal when ..."), which
  // round-trips real fetch + real proposal repo. Re-pinning the same flow
  // through DetailDrawer in jsdom adds brittle DOM coupling without new
  // coverage.

  // invariant: search filter dims non-matching, non-adjacent nodes purely
  // through the colour closure — no DOM mutation, no class toggling. The
  // canvas itself is opaque, so we sample the stub's data-color attribute
  // (which echoes nodeColor()) and check the alpha collapsed to 0.12.
  it("dims non-matching nodes via colour closure when a search filter is set", async () => {
    const user = userEvent.setup();
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.type(screen.getByPlaceholderText(/probe label/i), "alpha");
    await waitFor(() => {
      // n3 is two hops from the alpha match (n1) — neither match nor
      // adjacent → background state. Background alpha is the
      // SPOTLIGHT_BG_ALPHA constant (0.12).
      const n3Color = screen.getByTestId("fg-node-n3").getAttribute("data-color") ?? "";
      expect(n3Color).toMatch(/0\.12/);
    });
    // n1 (the match) stays at full recency alpha and never dims to background.
    const n1Color = screen.getByTestId("fg-node-n1").getAttribute("data-color") ?? "";
    expect(n1Color).not.toMatch(/0\.12/);
  });

  // invariant: when the search bar parses a time expression, the daemon
  // /soul/search endpoint is called and its returned object_ids drive the
  // spotlight; a chip below the search bar shows the parsed window label
  // and the actual hit count (not the daemon's unsliced total_count).
  it("calls /api/soul/search and highlights returned ids when a time expression parses", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_GRAPH), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            delivery_id: "delivery-1",
            results: [{ object_id: "n1", relevance_score: 0.9 }],
            total_count: 1
          }
        }),
        { status: 200 }
      )
    );
    renderGraphWithEnv();
    await screen.findByTestId("force-graph-2d");
    await user.type(screen.getByPlaceholderText(/probe label/i), "yesterday auth");
    await waitFor(() => {
      const chip = screen.getByTestId("search-time-window-chip");
      expect(chip.textContent).toMatch(/showing/i);
      expect(chip.textContent).toMatch(/1 hits/);
    });
    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]) =>
        typeof url === "string" && url.includes("/soul/search/ws-1")
      );
      expect(searchCall).toBeDefined();
    });
  });

  // invariant G8: Inspector is read-only — right-click on the graph viewport
  // never mounts a destructive context menu. See docs/handbook/invariants.md.
  it("does not surface a destructive context menu on right-click (G8)", async () => {
    renderGraphWithEnv();
    const viewport = await screen.findByTestId("force-graph-2d");
    fireEvent.contextMenu(viewport);
    expect(document.querySelector("menu[role='menu']")).toBeNull();
    // The graph viewport itself stays mounted (right-click did not unmount it).
    expect(screen.getByTestId("force-graph-2d")).toBeTruthy();
  });
});
