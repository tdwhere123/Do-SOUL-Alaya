import { ftsSurfaceTokens, sourceIndexNativeRootKey, SourceSemanticResourceExhausted,
  type FtsSurfaceToken, type SourceIndexQueryRepository, type SourceIndexTarget,
  type SourceSemanticResourceLedger, type SourceTemplateProposal } from "@do-soul/alaya-protocol";

type Frame = Readonly<{ left: readonly string[]; right: readonly string[]; role: "user" | "assistant" }>;
type Span = Readonly<{ start_byte: number; end_byte: number }>;
type SourceTemplateMatch = Readonly<{
  root_key: string; source: SourceIndexTarget; statement_hole_span: Span; source_hole_span: Span;
  message_id: string; asked_speaker: "user" | "assistant";
}>;
export type SourceTemplateInspection = Readonly<{
  status: "inapplicable" | "unknown" | "no_match" | "ambiguous" | "unique";
  inspected_roots: number; matched_roots: number; match?: SourceTemplateMatch;
  reason?: string;
}>;

function surface(text: string, meter: SourceSemanticResourceLedger): readonly FtsSurfaceToken[] {
  // Every UTF-16 unit can be a one-unit token separated from its neighbours.
  meter.charge(text.length, text.length * 256, "source template surface tokens");
  return ftsSurfaceTokens(text);
}

function frame(proposal: SourceTemplateProposal, meter: SourceSemanticResourceLedger): Frame | null {
  if (proposal.evidence_statements.length !== 1) return null;
  const text = proposal.evidence_statements[0]!;
  meter.charge(text.length, text.length * 4, "source template frame");
  const hole = /<([^<>]+)>/u.exec(text);
  if (hole === null || hole[1]!.trim().length === 0) return null;
  const leftText = text.slice(0, hole.index), rightText = text.slice(hole.index + hole[0].length);
  if (/[<>]/u.test(leftText + rightText)) return null;
  const left = surface(leftText, meter).map(token => token.text);
  const right = surface(rightText, meter).map(token => token.text);
  return left.length === 0 || right.length === 0 ? null : { left, right, role: proposal.asked_speaker };
}

function findSequence(tokens: readonly FtsSurfaceToken[], sequence: readonly string[], from: number,
  meter: SourceSemanticResourceLedger): number {
  for (let start = from; start + sequence.length <= tokens.length; start++) {
    let index = 0;
    for (; index < sequence.length; index++) {
      meter.charge(1, 0, "source template literal comparison");
      if (tokens[start + index]!.text !== sequence[index]) break;
    }
    if (index === sequence.length) return start;
  }
  return -1;
}

function matchFrame(text: string, proposal: Frame, meter: SourceSemanticResourceLedger): Span | null {
  const tokens = surface(text, meter), left = findSequence(tokens, proposal.left, 0, meter);
  if (left < 0) return null;
  const gapStart = left + proposal.left.length;
  const right = findSequence(tokens, proposal.right, gapStart + 1, meter);
  if (right < 0) return null;
  const start = tokens[gapStart]!.start, end = tokens[right - 1]!.end;
  meter.charge(end, end * 4, "source template UTF-8 coordinates");
  return { start_byte: Buffer.byteLength(text.slice(0, start), "utf8"),
    end_byte: Buffer.byteLength(text.slice(0, end), "utf8") };
}

/** A full eligible-prefix read establishes root uniqueness; a partial prefix never does.
 * Literal agreement is navigation evidence only, including text inside quotes or negation. */
export function inspectSourceTemplate(proposal: SourceTemplateProposal, roots: readonly SourceIndexTarget[],
  repository: Pick<SourceIndexQueryRepository, "readTemplateStatements">, meter: SourceSemanticResourceLedger,
  nativeBytes: (bytes: number) => void): SourceTemplateInspection {
  let inspected = 0, matches = 0, witness: SourceTemplateMatch | undefined;
  try {
    const compiled = frame(proposal, meter);
    if (compiled === null) return { status: "inapplicable", inspected_roots: 0, matched_roots: 0 };
    if (repository.readTemplateStatements === undefined) return {
      status: "unknown", inspected_roots: 0, matched_roots: 0, reason: "source_template_reader_unavailable" };
    for (const root of roots) {
      const read = repository.readTemplateStatements(root, meter.remaining());
      meter.charge(read.resources.work, read.resources.memory_bytes, "source template native read");
      nativeBytes(read.resources.native_bytes);
      if (read.status !== "complete") return { status: "unknown", inspected_roots: inspected,
        matched_roots: matches, reason: read.reason };
      inspected++;
      let match: SourceTemplateMatch | undefined;
      for (const row of read.statements) {
        if (row.bound.message.role !== compiled.role) continue;
        const statement = matchFrame(row.bound.statement.text, compiled, meter);
        if (statement === null) continue;
        const raw = matchFrame(row.bound.message.text, compiled, meter);
        if (raw === null) continue;
        match ??= { root_key: sourceIndexNativeRootKey(root), source: row.source, statement_hole_span: statement,
          source_hole_span: { start_byte: row.bound.source_span[0] + raw.start_byte,
            end_byte: row.bound.source_span[0] + raw.end_byte },
          message_id: row.bound.message.message_id, asked_speaker: compiled.role };
      }
      if (match !== undefined) { matches++; witness ??= match; }
    }
    return { status: matches === 1 ? "unique" : matches === 0 ? "no_match" : "ambiguous",
      inspected_roots: inspected, matched_roots: matches, ...(matches === 1 ? { match: witness! } : {}) };
  } catch (error) {
    return { status: "unknown", inspected_roots: inspected, matched_roots: matches,
      reason: error instanceof SourceSemanticResourceExhausted ? error.phase : "source_template_read_failed_unknown_cost" };
  }
}
