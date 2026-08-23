import { StorageTier } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP
} from "../../coarse-filter/coarse-candidates.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import type {
  CharNgramConsumerFact,
  SourceProximityConsumerFact
} from "./types.js";

// char_ngrams is compiled onto Q_q probes and copied into diagnostics only.
const CHAR_NGRAM_CONSUMER: CharNgramConsumerFact = Object.freeze({
  compiled: true,
  retrieval_consumer: "none"
});

export function inspectCharNgramConsumer(
  probes: Readonly<RecallQueryProbes>
): CharNgramConsumerFact {
  if (!Array.isArray(probes.char_ngrams)) {
    throw new Error("char_ngrams must be compiled onto query probes");
  }
  return CHAR_NGRAM_CONSUMER;
}

export function inspectSourceProximityConsumer(): SourceProximityConsumerFact {
  // Neighbor index is the coarse-filter HOT window, not a global corpus.
  return Object.freeze({
    substrate: StorageTier.HOT,
    radius: DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
    seed_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP,
    admission_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP
  });
}
