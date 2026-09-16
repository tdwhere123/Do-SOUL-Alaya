import type { GraphLink, GraphNode } from "../../types/graph";

export interface GraphData {
  readonly nodes: GraphNode[];
  readonly links: GraphLink[];
  readonly meta: {
    readonly truncated: boolean;
    readonly nodeTotal: number;
    readonly edgeTotal: number;
  };
}

export type ViewMode = "2d" | "3d";

export const DEFAULT_GRAPH_VIEW_MODE: ViewMode = "2d";
