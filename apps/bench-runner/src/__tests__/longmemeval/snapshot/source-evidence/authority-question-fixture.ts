import type { LongMemEvalQuestion } from
  "../../../../datasets/longmemeval/ingestion/dataset.js";

export const SOURCE_EVIDENCE_USER_CONTENT =
  "I plan to take the 7:15 train from Central Station.\nAssistant: quoted marker inside user text.";
export const SOURCE_EVIDENCE_ASSISTANT_CONTENT =
  "Noted on both lines.\nUser: quoted marker inside assistant text.";

export function sourceEvidenceCorpus(): string {
  return `User: ${SOURCE_EVIDENCE_USER_CONTENT}\nAssistant: ${SOURCE_EVIDENCE_ASSISTANT_CONTENT}`;
}

export function sourceEvidenceQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-source-evidence-authority",
    question_type: "single-session-assistant",
    question: "Which train does the user plan to take?",
    answer: "The 7:15 train from Central Station.",
    question_date: "2026-07-22T00:00:00.000Z",
    haystack_session_ids: ["answer-session"],
    haystack_dates: ["2026-07-20T00:00:00.000Z"],
    haystack_sessions: [[
      { role: "user", content: SOURCE_EVIDENCE_USER_CONTENT, has_answer: true },
      { role: "assistant", content: SOURCE_EVIDENCE_ASSISTANT_CONTENT, has_answer: false },
      {
        role: "user",
        content: "I check the platform near the main entrance.",
        has_answer: false
      }
    ]],
    answer_session_ids: ["answer-session"]
  };
}
