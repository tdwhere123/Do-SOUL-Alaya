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
  origin_kind?: "user_memory" | "engineering_chunk" | "proposal_pending" | "system";
  evidence_refs?: readonly string[];
  rationale?: string;
  confidence?: number;
  last_used_at?: string;
  last_hit_at?: string;
  influence_count?: number;
  degree?: number;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  kind: string;
  weight?: number;
  strength_normalized?: number;
  stability_class?: "volatile" | "normal" | "stable" | "pinned";
  last_reinforced_at?: string;
}

export type SpotlightState = "match" | "adjacent" | "background";
