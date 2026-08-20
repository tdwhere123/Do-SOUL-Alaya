import type { SliceCompatibilityV2 } from "../slice-key-selector.js";

export type ActivationNode = Readonly<{
  readonly candidate_key: string;
  readonly workspace_id: string;
  readonly principal: string;
  readonly scope: string;
  readonly generation_id: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly adopted_bridge: string | null;
  readonly sealed: boolean;
  readonly erased: boolean;
  readonly revoked: boolean;
  readonly authorized_anchor: boolean;
  readonly task_factor_id: string | null;
}>;

export type ActivationEdge = Readonly<{
  readonly from: string;
  readonly to: string;
  readonly channel: string;
  readonly lambda: number;
  readonly hop_cost: number;
  readonly source: string;
  readonly generation_id: string;
}>;

export type ActivationGraph = Readonly<{
  readonly nodes: readonly ActivationNode[];
  readonly edges: readonly ActivationEdge[];
  readonly rho_by_channel: Readonly<Record<string, number>>;
}>;

export type ActivationWritePort = Readonly<{
  persist(record: unknown): void;
}>;

export type ActivationSlicePort = Readonly<{
  compatibility(input: Readonly<{
    readonly source: ActivationNode;
    readonly target: ActivationNode;
    readonly channel: string;
  }>): SliceCompatibilityV2["decision"];
}>;
