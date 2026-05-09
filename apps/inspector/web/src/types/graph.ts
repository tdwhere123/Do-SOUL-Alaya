// Simulation fields (x/y/z/vx/vy/vz/fx/fy/fz) are mutated in place by the
// react-force-graph d3 simulation wrapper. The d3-force types accept `null`
// for fx/fy to "release" a pinned node, but react-force-graph's NodeObject
// only allows `number | undefined`. Declare explicitly so both libraries are
// satisfied without a wider `as any` escape hatch.
export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  scope_id?: string;
  workspace_id?: string;
  created_at?: string;
  origin_plane?: "project" | "global";
  origin_kind?:
    | "user_memory"
    | "engineering_chunk"
    | "reviewed_engineering_chunk"
    | "proposal_pending"
    | "system";
  evidence_refs?: readonly string[];
  rationale?: string;
  confidence?: number;
  last_used_at?: string;
  last_hit_at?: string;
  influence_count?: number;
  degree?: number;
  // Populated by the force simulation; allow undefined but not null.
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface GraphLink {
  id: string;
  kind: string;
  source: string | GraphNode;
  target: string | GraphNode;
  weight?: number;
  strength_normalized?: number;
  stability_class?: "volatile" | "normal" | "stable" | "pinned";
  last_reinforced_at?: string;
}

export type SpotlightState = "match" | "adjacent" | "background";
