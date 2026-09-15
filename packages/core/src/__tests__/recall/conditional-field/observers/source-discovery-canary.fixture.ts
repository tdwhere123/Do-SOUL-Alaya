import type { QuerySourceSketch } from "../../../../recall/conditional-field/query/query-source-sketch.js";

export type CanaryGroupId = "aspiration" | "capability" | "release";

export type CanaryCase = Readonly<{
  readonly group: CanaryGroupId;
  readonly original_query: string;
  readonly intended: string;
  readonly distractor: string;
  readonly sketch: QuerySourceSketch["relation"];
  readonly unknown: string;
}>;

/** Provider-free mechanism fixtures. Not frozen-dataset or extraction inputs. */
export const SOURCE_DISCOVERY_CANARY: readonly CanaryCase[] = [
  {
    group: "aspiration",
    original_query: "What corporate aspiration did SHADOW hold for all audiences?",
    intended: "SHADOW holds a corporate aspiration to realize human potential for all audiences.",
    distractor: "Investors hold a corporate aspiration to realize human potential, and all audiences heard that rumor.",
    sketch: {
      predicate: "corporate aspiration",
      arguments: [{ role: "content", phrase: "human potential" }],
      qualifiers: [{ role: "audience", phrase: "all audiences" }]
    },
    unknown: "Do not treat aspiration as achieved capability or standing policy."
  },
  {
    group: "capability",
    original_query: "Who can access a full PC instantly on all owned devices?",
    intended: "Users can access a full PC instantly on all owned devices.",
    distractor: "Windows users can access a full PC instantly, and all owned devices sat unused in storage.",
    sketch: {
      predicate: "access",
      arguments: [
        { role: "capability", phrase: "full PC" },
        { role: "devices", phrase: "all owned devices" }
      ],
      qualifiers: [{ role: "temporal", phrase: "instantly" }]
    },
    unknown: "Do not add Windows, observed usage, or a policy."
  },
  {
    group: "release",
    original_query: "What did the 2016 original product release promise for all individuals?",
    intended: "SHADOW's original product was released in 2016 with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud.",
    distractor: "A vendor released a 2016 memo. The original product stayed private, with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud belonging to another team.",
    sketch: {
      predicate: "released",
      arguments: [
        { role: "theme", phrase: "original product" },
        { role: "promise", phrase: "promise of allowing all individuals to enjoy the power of a high-end PC from the cloud" }
      ],
      qualifiers: [{ role: "year", phrase: "2016" }]
    },
    unknown: "Promisor and fulfillment remain unknown."
  }
];
