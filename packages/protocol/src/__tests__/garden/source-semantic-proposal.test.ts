import { expect, it } from "vitest";
import { SourceSemanticProposalSchema, materializeSourceSemanticProposal } from "../../garden/source-semantic-proposal.js";
import { SourceSemanticResponseEnvelopeSchema } from "../../garden/source-semantic-interpretation.js";

function proposal() {
  const support = [{ kind: "lexical", mentions: ["mPromise"] }];
  const frame = (id: string, owner: object) => ({
    id, assertion_ids: [1], context_owner: owner, additional_support: [],
    predicate_support: { kind: "explicit", reading: id === "fPromise" ? "promise" : "send", mentions: ["mPromise"] },
    slots: [], bindings: []
  });
  return {
    contract: "source-semantic-proposal-v1", outcome: { status: "interpreted" },
    draft: {
      contract: "source-interpretation-v4",
      mentions: [{ id: "mPromise", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
      referents: [],
      frames: [frame("fPromise", { kind: "source_act", source_act: "assertion" }),
        frame("fSend", { kind: "embedding", parent_frame: "fPromise" })],
      operators: [],
      gaps: [{ kind: "missing_binding", affected_ids: ["fPromise", "fSend"], support }]
    }
  };
}

it("derives the occurrence self-reference and the canonical gap echo without changing raw input", () => {
  const input = proposal(), before = JSON.stringify(input);
  const canonical = materializeSourceSemanticProposal(input);
  expect(canonical.contract).toBe("source-interpretation-response-v4");
  expect(canonical.draft?.frames[1]?.context_owner).toEqual({
    kind: "embedding", parent_frame: "fPromise", content_argument: "fSend"
  });
  expect(canonical.outcome).toEqual({ status: "interpreted", gaps: input.draft.gaps });
  expect(SourceSemanticResponseEnvelopeSchema.safeParse(canonical).success).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});

it("does not allow producer restatement of host-derived fields", () => {
  const input = proposal();
  expect(SourceSemanticProposalSchema.safeParse({ ...input,
    outcome: { ...input.outcome, gaps: input.draft.gaps } }).success).toBe(false);
  input.draft.frames[1]!.context_owner = { kind: "embedding", parent_frame: "fPromise", content_argument: "fSend" };
  expect(SourceSemanticProposalSchema.safeParse(input).success).toBe(false);
});

it.each(["unknown_parent", "self_parent", "mention_target", "unknown_slot"])("retains canonical rejection of %s", (failure) => {
  const input = proposal();
  if (failure === "unknown_parent" || failure === "self_parent") {
    input.draft.frames[1]!.context_owner = { kind: "embedding", parent_frame: failure === "self_parent" ? "fSend" : "absent" };
  } else {
    Object.assign(input.draft.frames[0]!, {
      slots: [{ id: "content", role_reading: "promised event", support: [] }],
      bindings: [{ slot_id: failure === "unknown_slot" ? "absent" : "content",
        target: { kind: "node", id: failure === "mention_target" ? "mPromise" : "fSend" }, support: [] }]
    });
  }
  expect(() => materializeSourceSemanticProposal(input)).toThrow();
});

it("keeps non-interpretation outcomes distinct and forbids a draft on abstention", () => {
  expect(materializeSourceSemanticProposal({ contract: "source-semantic-proposal-v1",
    outcome: { status: "abstained" } }).outcome).toEqual({ status: "abstained" });
  expect(SourceSemanticProposalSchema.safeParse({ ...proposal(), outcome: { status: "abstained" } }).success).toBe(false);
});

it("does not salvage a historical response with an incorrect embedding self-reference", () => {
  const old = materializeSourceSemanticProposal(proposal());
  const invalid = { ...old, draft: { ...old.draft!, frames: old.draft!.frames.map((frame) => frame.id === "fSend"
    ? { ...frame, context_owner: { kind: "embedding", parent_frame: "fPromise", content_argument: "content" } } : frame) } };
  expect(SourceSemanticResponseEnvelopeSchema.safeParse(invalid).success).toBe(false);
  expect(SourceSemanticProposalSchema.safeParse(invalid).success).toBe(false);
});
