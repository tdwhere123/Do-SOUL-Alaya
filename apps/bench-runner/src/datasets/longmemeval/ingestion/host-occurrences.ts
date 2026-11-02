import { AlayaError, canonicalJson, type HostOccurrence, type SourceAdmissionContext } from "@do-soul/alaya-protocol";
import { assertVerifiedLongMemEvalDatasetMembership, type LoadedLongMemEvalDataset } from "./fetch.js";
import { buildLongMemEvalRoundMessages, pairSessionIntoRounds } from "./dataset.js";

export type LongMemEvalHostCapture = Readonly<{
  occurrences: readonly HostOccurrence[];
  authorize: NonNullable<SourceAdmissionContext["hostCapture"]>;
}>;

/** Per-message source records keep the opaque membership capability alive until the host admission call. */
export function createLongMemEvalHostCapturePolicy(dataset: LoadedLongMemEvalDataset) {
  const questions = structuredClone(dataset.questions);
  const authority = dataset.promotionAuthority;
  const datasetSha256 = dataset.sha256;
  const membership = { variant: "longmemeval_s" as const, sha256: datasetSha256, questions };
  assertVerifiedLongMemEvalDatasetMembership(authority, membership);
  return (input: Readonly<{ questionId: string; sessionIndex: number; roundIndex: number;
    sourceId: string; sourceVersion: string; messageIndex: number }>): LongMemEvalHostCapture => {
    const question = questions.find(row => row.question_id === input.questionId);
    const rawSession = question?.haystack_sessions[input.sessionIndex];
    if (rawSession === undefined) throw new AlayaError("VALIDATION", "host capture session coordinate unavailable");
    const session = rawSession.map(({ role, content }) => ({ role, content }));
    const round = pairSessionIntoRounds(session)[input.roundIndex];
    if (round === undefined) throw new AlayaError("VALIDATION", "host capture round coordinate unavailable");
    const messages = buildLongMemEvalRoundMessages(session, round,
      `${input.questionId}-s${input.sessionIndex}-r${input.roundIndex}`);
    const selected = round.messageIndices.indexOf(input.messageIndex);
    if (selected < 0) throw new AlayaError("VALIDATION", "host capture message coordinate unavailable");
    const content = messages[selected]!.content;
    const scope = `longmemeval:${datasetSha256}`;
    const sourceId = input.sourceId, sourceVersion = input.sourceVersion;
    const occurrences: readonly HostOccurrence[] = Object.freeze([Object.freeze({
      occurrence_id: `${input.questionId}:s${input.sessionIndex}:m${input.messageIndex}`,
      utf8_span: [0, Buffer.byteLength(content, "utf8")] as const, role: session[input.messageIndex]!.role, channel: null,
      author_ref: null, container_ref: { scope, id: `${input.questionId}:s${input.sessionIndex}` }, upstream_message_ref: null,
      upstream_position: input.messageIndex, completeness: "complete" as const, fidelity: "original_bytes" as const
    })]);
    const expected = canonicalJson(occurrences);
    return { occurrences, authorize(request) {
      assertVerifiedLongMemEvalDatasetMembership(authority, { ...membership, questions: [question!] });
      if (request.source_id !== sourceId || request.source_version !== sourceVersion ||
          request.content_bytes !== content || canonicalJson(request.host_occurrences) !== expected) {
        throw new AlayaError("CONFLICT", "host capture differs from pinned structured source coordinates");
      }
      return { namespace: scope, workspace_id: request.workspace_id, producer: "longmemeval-structured-source", basis: "pinned_dataset" };
    } };
  };
}
