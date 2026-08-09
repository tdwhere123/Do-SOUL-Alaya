import type { OpenSemanticFactorGraphProposal } from "@do-soul/alaya-protocol";

export interface OpenSemanticFactorExtractionPort {
  readonly operator_id: string;
  extract(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
}
