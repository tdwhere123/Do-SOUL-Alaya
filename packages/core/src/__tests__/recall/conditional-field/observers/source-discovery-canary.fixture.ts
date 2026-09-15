import type { QuerySourceSketch } from "../../../../recall/conditional-field/query/query-source-sketch.js";

export type CanaryGroupId = "aspiration" | "capability" | "release";

export type CanaryCase = Readonly<{
  readonly group: CanaryGroupId;
  readonly original_query: string;
  readonly intended: string;
  readonly distractor: string;
  readonly sketch: NonNullable<QuerySourceSketch["relation"]>;
  readonly unknown: string;
  readonly event_time?: string;
}>;

/** Provider-free mechanism fixtures. Contract wordings ID2/ID4/ID8; not frozen-dataset inputs. */
export const SOURCE_DISCOVERY_CANARY: readonly CanaryCase[] = [
  {
    group: "aspiration",
    original_query: "What corporate aspiration did SHADOW hold for all audiences?",
    intended: "Shadow strives to become the definitive cloud platform for gamers, creatives, and businesses, because we believe that cloud technologies have the potential to bring technological freedom to all.",
    distractor: "Investors heard that Shadow strives to become the definitive cloud platform for gamers, creatives, and businesses, because they believe that cloud technologies have the potential to bring technological freedom to all, and all audiences heard that rumor.",
    sketch: {
      predicate: "strives",
      arguments: [{ role: "aim", phrase: "definitive cloud platform" }],
      qualifiers: [
        { role: "audience", phrase: "gamers, creatives, and businesses" },
        { role: "scope", phrase: "potential to bring technological freedom to all" }
      ]
    },
    unknown: "Do not treat aspiration as achieved capability or standing policy."
  },
  {
    group: "capability",
    original_query: "Who can access a full PC instantly on all owned devices?",
    intended: "Shadow is the easiest way to access a full PC, instantly, on all the devices you own.",
    distractor: "Windows is the easiest way to access a full PC instantly, and all the devices you own sat unused in storage.",
    sketch: {
      predicate: "access",
      arguments: [
        { role: "capability", phrase: "full PC" },
        { role: "devices", phrase: "all the devices you own" }
      ],
      qualifiers: [{ role: "temporal", phrase: "instantly" }]
    },
    unknown: "Do not add Windows, observed usage, or a policy."
  },
  {
    group: "release",
    original_query: "What did the 2016 original product release promise for all individuals?",
    intended: "SHADOW\u2019s original product was released in 2016 with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud.",
    distractor: "A vendor released a 2016 memo. The original product stayed private, with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud belonging to another team.",
    sketch: {
      predicate: "released",
      arguments: [
        { role: "theme", phrase: "original product" },
        { role: "promise", phrase: "promise of allowing all individuals to enjoy the power of a high-end PC from the cloud" }
      ]
    },
    unknown: "Promisor and fulfillment remain unknown.",
    event_time: "2016-01-01T00:00:00.000Z"
  }
];
