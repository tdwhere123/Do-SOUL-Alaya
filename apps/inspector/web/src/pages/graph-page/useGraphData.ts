import { useCallback } from "react";
import type { SoulPathGraphContract } from "@do-soul/alaya-protocol";
import { apiFetch } from "../../api";
import { useApiQuery } from "../../hooks/useApiQuery";
import { extractId } from "../../utils/graph";
import { mapPathGraphEdge, mapPathGraphNode, unwrapPathGraph } from "./support";
import type { GraphData } from "./types";

interface PathGraphEnvelope {
  readonly success: boolean;
  readonly data: SoulPathGraphContract;
}

export function useGraphData(workspaceId: string | null) {
  const fetchGraphData = useCallback(async (signal: AbortSignal): Promise<GraphData> => {
    const result = await apiFetch<SoulPathGraphContract | PathGraphEnvelope>(`/graph/${workspaceId}`, {
      signal
    });
    const graph = unwrapPathGraph(result);
    const nodes = (graph.nodes ?? []).map(mapPathGraphNode);
    const links = (graph.edges ?? []).map(mapPathGraphEdge);
    const degreeBy = new Map<string, number>();

    links.forEach((link) => {
      degreeBy.set(extractId(link.source), (degreeBy.get(extractId(link.source)) ?? 0) + 1);
      degreeBy.set(extractId(link.target), (degreeBy.get(extractId(link.target)) ?? 0) + 1);
    });
    nodes.forEach((node) => {
      node.degree = degreeBy.get(node.id) ?? 0;
    });

    return {
      nodes,
      links,
      meta: {
        truncated: false,
        nodeTotal: graph.topology.total_nodes,
        edgeTotal: graph.topology.total_edges
      }
    };
  }, [workspaceId]);

  return useApiQuery(fetchGraphData, [workspaceId], {
    enabled: workspaceId !== null
  });
}
