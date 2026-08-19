import type {
  CertifiedQueryOsfGraph,
  OpenSemanticFactorGraphProposal,
  QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";

export interface OpenSemanticFactorExtractionPort {
  readonly operator_id: string;
  extract(
    sourceKind: "evidence" | "query",
    sourceText: string
  ): Promise<Readonly<OpenSemanticFactorGraphProposal> | null>;
  extractCertifiedQuery?(
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ): Promise<Readonly<CertifiedQueryOsfGraph> | null>;
}
