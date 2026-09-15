import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  hashContentDigest,
  locateSourceInterpretation,
  sourceRecallTarget,
  type BoundSourceInterpretation,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import {
  observeConditionalField,
  startObserverCursor,
  type ObserverReaders,
  type SourceRootObserverRow
} from "../../../../recall/conditional-field/observers/observe.js";
import { compileQuerySourceSketch } from "../../../../recall/conditional-field/query/query-source-sketch.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "../reference/deployment.fixture.js";
import { SOURCE_DISCOVERY_CANARY, type CanaryCase } from "./source-discovery-canary.fixture.js";

describe("source discovery canary", () => {
  it.each(SOURCE_DISCOVERY_CANARY)(
    "$group: proposal lookup selects the intended context under a one-context hint budget",
    (canary) => {
      const planted = plantCanary(canary);
      const proposal = measurePage(planted.proposalQuery, planted.proposalReaders, 1);
      expect(proposal.firstId).toBe(planted.intended.root_id);
      expect(proposal.firstId).not.toBe(planted.distractor.root_id);
      expect(proposal.wording).toBe(canary.intended);
      expect(proposal.ids).toEqual([planted.intended.root_id]);
      const text = measurePage(planted.textQuery, planted.textReaders, 1);
      expect(text.firstId).toBe(planted.distractor.root_id);
      expect(text.visits).toBeGreaterThan(0);
      expect(proposal.visits).toBeGreaterThan(0);
      expect(proposal.bytes).toBeGreaterThan(0);
      expect(text.bytes).toBeGreaterThan(0);
    }
  );

  it("keeps unrepresented scope unknown and does not infer aliases", () => {
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const planted = plantCanary(canary);
    const polarity = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: sourceOnlyView(),
      sketch: {
        original_query: `${canary.original_query} unless it was withdrawn`,
        relation: canary.sketch,
        unresolved_alternatives: ["negation", "withdrawn"]
      }
    });
    expect(polarity.status).toBe("partial");
    expect(polarity.holes.some((hole) => hole.hole_id.startsWith("hole.query.alternative"))).toBe(true);
    expect(measurePage(polarity, planted.proposalReaders, 1).firstId).toBe(planted.intended.root_id);
  });
});

function measurePage(
  query: QueryInterpretation,
  readers: ObserverReaders,
  workLimit: number
) {
  const observed = observeConditionalField({
    lease: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      lease_id: "lease-1",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      status: "active"
    },
    action: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: "seed",
      region_id: "seed",
      work_limit: workLimit
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      region_id: "seed"
    }),
    query,
    workspace_id: "ws",
    authorized_scopes: null,
    readers
  });
  return {
    firstId: observed.page.observations[0]?.object_id,
    ids: observed.page.observations.map((row) => row.object_id),
    wording: observed.source_roots?.[0]?.content,
    visits: observed.work.native_visits,
    bytes: observed.work.bytes_read,
    exposed: observed.page.observations.length
  };
}

function plantCanary(canary: CanaryCase) {
  const intended = sourceRoot("intended", canary.intended);
  const distractor = sourceRoot("distractor", canary.distractor);
  const intendedBound = boundOf(canary, canary.intended, intended, intendedRoles(canary));
  const distractorBound = boundOf(canary, canary.distractor, distractor, distractorRoles(canary));
  const proposalQuery = compileSketch(canary, "proposal");
  const textQuery = compileSketch(canary, "source_text");
  return {
    intended,
    distractor,
    proposalQuery,
    textQuery,
    proposalReaders: readers([intended, distractor], [intendedBound, distractorBound], "proposal"),
    textReaders: readers([distractor, intended], [intendedBound, distractorBound], "source_text")
  };
}

function compileSketch(canary: CanaryCase, lookup_mode: "proposal" | "source_text") {
  return compileQuerySourceSketch({
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK,
    view: sourceOnlyView(),
    sketch: {
      original_query: canary.original_query,
      relation: canary.sketch,
      lookup_mode
    }
  });
}

function readers(
  roots: readonly SourceRootObserverRow[],
  bounds: readonly BoundSourceInterpretation[],
  mode: "proposal" | "source_text"
): ObserverReaders {
  return {
    sourceRoots: ({ afterCursor, limit, nativeLimit }) => {
      const take = Math.max(0, Math.min(limit, nativeLimit));
      const start = afterCursor === null ? 0 : roots.findIndex((row) => row.root_id === afterCursor) + 1;
      const page = roots.slice(Math.max(0, start), Math.max(0, start) + take);
      return {
        rows: page,
        nativeVisits: page.length,
        nativeBytes: 8,
        rowsRead: page.length,
        bytesRead: 8,
        truncated: start + page.length < roots.length,
        committedThrough: page.at(-1)?.root_id ?? afterCursor
      };
    },
    sourceRoot: (input) => {
      const row = roots.find((item) => item.root_id === input.rootId);
      return row === undefined
        ? { row: null, rowsRead: 1, bytesRead: 0, unavailable: true }
        : { row, rowsRead: 1, bytesRead: Buffer.byteLength(row.content ?? "", "utf8"), unavailable: false };
    },
    boundInterpretations: ({ afterCursor, limit }) => {
      const start = afterCursor === null ? 0 : bounds.findIndex((row) =>
        row.source_target.evidence_object_id === afterCursor) + 1;
      const page = bounds.slice(Math.max(0, start), Math.max(0, start) + Math.max(1, limit));
      return {
        rows: page.map((bound) => ({
          object_id: bound.source_target.evidence_object_id ?? bound.source_target.root_id,
          gist: JSON.stringify(bound)
        })),
        nativeVisits: page.length,
        nativeBytes: 8,
        rowsRead: page.length,
        bytesRead: 8,
        truncated: start + page.length < bounds.length,
        committedThrough: page.at(-1)?.source_target.evidence_object_id ?? afterCursor
      };
    },
    sourceTextHints: ({ afterCursor, limit }) => {
      if (mode !== "source_text") {
        return { rows: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0,
          truncated: false, committedThrough: afterCursor };
      }
      const start = afterCursor === null ? 0 : roots.findIndex((row) => row.root_id === afterCursor) + 1;
      const page = roots.slice(Math.max(0, start), Math.max(0, start) + Math.max(1, limit));
      return {
        rows: page,
        nativeVisits: page.length,
        nativeBytes: 8,
        rowsRead: page.length,
        bytesRead: 8,
        truncated: start + page.length < roots.length,
        committedThrough: page.at(-1)?.root_id ?? afterCursor
      };
    }
  };
}

function boundOf(
  canary: CanaryCase,
  source: string,
  root: SourceRootObserverRow,
  relation: Parameters<typeof locateSourceInterpretation>[0]["response"]
): BoundSourceInterpretation {
  const located = locateSourceInterpretation({
    source,
    artifactKey: root.root_id,
    sha256: fieldContractSha256,
    assertion: { assertion_id: 1, text: source, source_span: [0, source.length] },
    response: relation
  });
  if (located.outcome !== "candidates") {
    throw new Error(`${canary.group} fixture failed to locate: ${JSON.stringify(located.diagnostics)}`);
  }
  return {
    ...located,
    source_target: sourceRecallTarget({
      workspace_id: root.workspace_id,
      root_kind: root.kind,
      root_id: root.root_id,
      source_version: root.revision,
      content_digest: root.digest,
      evidence_object_id: root.evidence_object_id
    })
  };
}

function intendedRoles(canary: CanaryCase) {
  return received(canary.sketch);
}

function distractorRoles(canary: CanaryCase) {
  if (canary.group === "aspiration") {
    return received({
      predicate: "corporate aspiration",
      arguments: [{ role: "content", phrase: "human potential" }],
      qualifiers: [{ role: "audience", phrase: "Investors" }]
    });
  }
  if (canary.group === "capability") {
    return received({
      predicate: "access",
      arguments: [
        { role: "capability", phrase: "full PC" },
        { role: "devices", phrase: "storage" }
      ],
      qualifiers: [{ role: "temporal", phrase: "instantly" }]
    });
  }
  return received({
    predicate: "released",
    arguments: [
      { role: "theme", phrase: "2016 memo" },
      { role: "promise", phrase: "promise of allowing all individuals to enjoy the power of a high-end PC from the cloud" }
    ],
    qualifiers: [{ role: "year", phrase: "2016" }]
  });
}

function received(relation: NonNullable<CanaryCase["sketch"]>) {
  return {
    kind: "received" as const,
    value: {
      interpretations: [{
        assertion_id: 1,
        relations: [{
          predicate: { text: relation.predicate },
          arguments: (relation.arguments ?? []).map((item) => ({
            role: item.role, phrase: { text: item.phrase }
          })),
          qualifiers: (relation.qualifiers ?? []).map((item) => ({
            role: item.role, phrase: { text: item.phrase }
          }))
        }]
      }]
    }
  };
}

function sourceRoot(rootId: string, content: string): SourceRootObserverRow {
  return {
    kind: "source_record",
    workspace_id: "ws",
    root_id: rootId,
    revision: "v1",
    digest: hashContentDigest(content, fieldContractSha256),
    evidence_object_id: `evidence-${rootId}`,
    content,
    content_complete: true
  };
}

function sourceOnlyView() {
  return { ...defaultView(), result_kind_view: "source_only" as const };
}
