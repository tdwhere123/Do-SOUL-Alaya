import type { RecallQueryDemand } from "../../query/recall-query-demand.js";
import { extendRecallQueryDemandWithSourceExactLexicalTerms } from
  "../../query/recall-query-demand.js";
import type { QueryFactFrameExtractionPort } from
  "../../../shared/query-fact-frame-extraction-port.js";
import {
  aggregateRecallQueryFieldAttributionContributions,
  type RecallQueryFieldAttributionContribution,
  type RecallQueryFieldAttributionReceipt
} from "../../field/query-attribution/query-field-attribution.js";
import {
  captureRecallQueryFactFrames,
  collectRelationDemandTermsFromFactFrameCapture,
  createUnavailableRecallQueryFactFrameCapture,
  produceRelationQueryFieldAttributionContribution,
  type RecallQueryFactFrameExtractionCapture
} from "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import {
  produceEntityQueryFieldAttributionContribution,
  type RecallQueryEntityExtractionCapture
} from "../../field/query-entity-attribution-producer.js";

export async function collectQueryFieldAttribution(params: Readonly<{
  readonly queryText: string | null;
  readonly queryDemand: Readonly<RecallQueryDemand>;
  readonly entityCapture: Readonly<RecallQueryEntityExtractionCapture>;
  readonly factFramePort?: QueryFactFrameExtractionPort;
  readonly onFailure?: (error: unknown) => void;
}>): Promise<Readonly<{
  readonly factFrameCapture: Readonly<RecallQueryFactFrameExtractionCapture>;
  readonly attribution?: Readonly<RecallQueryFieldAttributionReceipt>;
}>> {
  const factFrameCapture = await captureRecallQueryFactFrames({
    query_text: params.queryText,
    port: params.factFramePort,
    on_failure: params.onFailure
  });
  try {
    const attribution = materializeQueryFieldAttribution({
      queryText: params.queryText,
      queryDemand: params.queryDemand,
      entityCapture: params.entityCapture,
      factFrameCapture
    });
    return Object.freeze({
      factFrameCapture,
      ...(attribution === undefined ? {} : { attribution })
    });
  } catch (error) {
    params.onFailure?.(error);
    return Object.freeze({
      factFrameCapture: createUnavailableRecallQueryFactFrameCapture(params.queryText)
    });
  }
}

export function materializeQueryFieldAttribution(params: Readonly<{
  readonly queryText: string | null;
  readonly queryDemand: Readonly<RecallQueryDemand>;
  readonly entityCapture: Readonly<RecallQueryEntityExtractionCapture>;
  readonly factFrameCapture?: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): RecallQueryFieldAttributionReceipt | undefined {
  const queryDemand = extendRecallQueryDemandWithSourceExactLexicalTerms(
    params.queryDemand,
    params.factFrameCapture === undefined
      ? []
      : collectRelationDemandTermsFromFactFrameCapture(params.factFrameCapture)
  );
  const entity = produceEntityQueryFieldAttributionContribution({
    query_text: params.queryText,
    query_demand: queryDemand,
    capture: params.entityCapture
  });
  const relation = params.factFrameCapture === undefined
    ? undefined
    : produceRelationQueryFieldAttributionContribution({
        query_text: params.queryText,
        query_demand: queryDemand,
        capture: params.factFrameCapture
      });
  const contributions = [entity, relation].filter(
    (value): value is RecallQueryFieldAttributionContribution => value !== undefined
  );
  if (contributions.length === 0) return undefined;
  return aggregateRecallQueryFieldAttributionContributions({
    query_demand: queryDemand,
    contributions
  });
}
