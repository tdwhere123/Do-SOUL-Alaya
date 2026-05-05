import type { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  scope_id?: string;
  workspace_id?: string;
  created_at?: string;
  origin_plane?: "project" | "global";
  degree?: number;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  kind: string;
}

export type SpotlightState = "match" | "adjacent" | "background";
