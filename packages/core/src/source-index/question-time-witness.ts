import { statementEventIntervals } from "@do-soul/alaya-graph-algorithms";
import { SourceSemanticResourceExhausted, sourceStatementKey, type QuestionTimePreference,
  type SourceIndexQueryRepository, type SourceIndexTarget, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

export type QuestionTimeWitnessDecision = Readonly<{
  status: "injected" | "unchanged" | "no_free_slot" | "unknown"; reason: string | null;
  witnesses: number; root_position: number | null; slot: number | null;
}>;

const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0, l = 0, r = 0;
  for (let i = 0; i < left.length; i++) { dot += left[i]! * right[i]!; l += left[i]! * left[i]!; r += right[i]! * right[i]!; }
  return l === 0 || r === 0 ? -Infinity : dot / Math.sqrt(l * r);
}

/** A root witnesses the question window when one of its user statements states an event day inside a
 * window alternative, read against the statement's session day. The witness closest to the query (cosine
 * over its dated keys; ties to the earlier position) enters the first five in place of the last slot 5..2
 * whose root neither witnesses the window nor may lie in it (no stated time and a session in the window,
 * or unread). Session time alone never witnesses; membership never changes. */
export function preferQuestionTimeWitness(input: Readonly<{
  order: readonly string[]; sources: ReadonlyMap<string, SourceIndexTarget>; preference: QuestionTimePreference;
  query: Float32Array; repository: Pick<SourceIndexQueryRepository, "readTemplateStatements" | "readStatementKeyVectors">;
  meter: SourceSemanticResourceLedger; nativeBytes: (bytes: number) => void;
}>): Readonly<{ order: readonly string[]; decision: QuestionTimeWitnessDecision }> {
  const { order, repository, meter } = input;
  let witnesses = 0;
  const unchanged = (status: QuestionTimeWitnessDecision["status"], reason: string) =>
    ({ order, decision: { status, reason, witnesses, root_position: null, slot: null } });
  const clock = input.preference.interpretation_clock.slice(0, 10);
  const windows = input.preference.intervals.filter(window => window.start <= clock).map(window => [day(window.start), day(window.end)] as const);
  if (windows.length === 0) return unchanged("unchanged", "question_time_window_after_clock");
  if (repository.readTemplateStatements === undefined || repository.readStatementKeyVectors === undefined) {
    return unchanged("unknown", "question_time_witness_reader_unavailable");
  }
  const inWindow = (start: number, end: number) => windows.some(([from, to]) => start <= to && end >= from);
  try {
    const kept = new Set<string>();
    let best: { position: number; score: number } | undefined;
    order.forEach((root, position) => {
      const read = repository.readTemplateStatements!(input.sources.get(root)!, meter.remaining());
      meter.charge(read.resources.work, read.resources.memory_bytes, "question time witness statements");
      input.nativeBytes(read.resources.native_bytes);
      const sessions = read.status === "complete" ? read.statements.map(row => row.bound.message.recorded_at) : [];
      if (read.status !== "complete" || read.statements.length === 0 || sessions.some(session => session === null)) {
        kept.add(root); return;
      }
      let dated = false;
      const keys: SourceIndexTarget[] = [];
      read.statements.forEach((row, index) => {
        const text = sourceStatementKey(row.bound.statement);
        meter.charge(text.length, text.length * 8, "question time witness event days");
        const days = statementEventIntervals(text, day(sessions[index]!));
        dated ||= days.length > 0;
        if (row.bound.message.role === "user" && days.some(span => inWindow(span.startDay, span.endDay))) keys.push(row.source);
      });
      const session = day(sessions[0]!);
      if (!dated && inWindow(session, session)) kept.add(root);
      if (keys.length === 0) return;
      kept.add(root); witnesses++;
      const vectors = repository.readStatementKeyVectors!(keys, meter.remaining());
      meter.charge(vectors.resources.work, vectors.resources.memory_bytes, "question time witness vectors");
      input.nativeBytes(vectors.resources.native_bytes);
      if (vectors.status !== "ready") return;
      for (const vector of vectors.vectors) {
        if (vector === null || vector.length !== input.query.length) continue;
        meter.charge(vector.length, 0, "question time witness cosine");
        const score = cosine(vector, input.query);
        if (best === undefined || score > best.score) best = { position, score };
      }
    });
    if (best === undefined) return unchanged("unchanged", witnesses === 0 ? "question_time_no_witness" : "question_time_witness_unscored");
    const head = Math.min(5, order.length);
    if (best.position < head) return unchanged("unchanged", "question_time_witness_in_first_five");
    let slot = -1;
    for (let position = head - 1; position >= 1; position--) if (!kept.has(order[position]!)) { slot = position; break; }
    if (slot < 0) return unchanged("no_free_slot", "question_time_first_five_protected");
    const out = order.slice(0, head);
    out[slot] = order[best.position]!;
    const chosen = new Set(out);
    return { order: [...out, ...order.filter(root => !chosen.has(root))],
      decision: { status: "injected", reason: null, witnesses, root_position: best.position + 1, slot: slot + 1 } };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    return unchanged("unknown", `question_time_witness_budget:${error.phase}`);
  }
}
