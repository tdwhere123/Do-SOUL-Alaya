import type { SourceSemanticQuery, SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { ACCESS_BUDGET, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { aliceUsesDraft, correspondenceOf, ORIGINAL, queryOf } from "./source-semantic-library-binding-coverage.js";

export const sourceId = "large-authored-conditional-proof";
// Bounded multibyte gaps enlarge the genuine result without fabricated proof rows or identities.
export const gaps = Array.from({ length: 40 }, () => ({ kind: "unsupported_meaning" as const,
  affected_ids: [], support: [], description: "未解释的附加语义。".repeat(110) }));
const sources = [{ id: sourceId, text: "Alice uses Pixel.", verbatim: true,
  authoredDraft: (catalog: Parameters<typeof aliceUsesDraft>[0]) => ({ ...aliceUsesDraft(catalog, "Pixel", "omitted"), gaps }) }];

export function reasonRequest(interpretationId: string, groups: number): Extract<SourceSemanticWorkerRequest, { kind: "reason" }> {
  const original = queryOf();
  const frames = Array.from({ length: groups }, (_, index) => ({
    ...original.alternatives[0]!.frames[0]!, id: `qUse${index}`, variable: `use${index}`
  }));
  const semantics: SourceSemanticQuery = { ...original,
    variables: [...original.variables.filter(row => row.id === "actor" || row.id === "tools"),
      ...frames.map(row => ({ id: row.variable, sort: "proposition" as const }))],
    alternatives: Array.from({ length: Math.ceil(groups / 16) }, (_, index) => {
      const selected = frames.slice(index * 16, index * 16 + 16);
      return { frames: selected, context_obligations: selected.map(row => ({ frame: row.id, kind: "asserted_at_source" as const })),
        answer_frames: [], evidence_inputs: selected.map(row => ({ frames: [row.id] })) };
    }),
    gaps: Array.from({ length: 78 }, () => ({ kind: "aggregate" as const, affected_ids: ["tools"],
      support: [{ kind: "query_text" as const, excerpt: "tools" }], description: "未执行的查询条件。".repeat(110) })) };
  const originalCorrespondence = correspondenceOf(interpretationId, semantics, "omitted");
  const correspondence = { ...originalCorrespondence,
    correspondences: originalCorrespondence.correspondences.flatMap(row => row.query_endpoint.kind === "referent" ? [row]
      : frames.map((frame, index) => ({ ...row,
        query_endpoint: { ...row.query_endpoint, alternative: Math.floor(index / 16), frame: frame.id } }))) };
  return { kind: "reason", accepts_unreviewed_conditional_results: true, source_interpretation_id: interpretationId,
    original_query: ORIGINAL, query_semantics: semantics, semantic_correspondence: correspondence,
    budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 };
}

export async function withPublished(body: Parameters<typeof withAccessLibrary>[1]) {
  const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
  process.execArgv.push(guard);
  try { await withAccessLibrary(sources, body); }
  finally {
    const index = process.execArgv.lastIndexOf(guard);
    if (index !== -1) process.execArgv.splice(index, 1);
  }
}
