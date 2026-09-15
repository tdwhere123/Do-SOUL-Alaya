import { describe, expect, it } from "vitest";
import { groundAssociativeFactFrame } from "../../../evidence/associative-fact-frame.js";
import {
  evidenceFactFrameGraphIsComplete,
  groundEvidenceFactFrameObligation
} from "../../../evidence/formation/evidence-osf-semantic-completeness.js";
import {
  hasUnquotedSourceDependentScope,
  isInsideSourceQuotation
} from "../../../evidence/source-dependent-scope.js";
import {
  classifyFactFrameCertifierSupportDomain,
  compileSourceFrameSemanticGraph,
  skipLeadingAdjunctSpan,
  sliceFactFrameTokens,
  tokenizeFactFrameSource,
  tokenizeFactFrameWordPieces,
  RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer
} from "../../../node/source-frame.js";

describe("source-frame support surfaces", () => {
  it("tokenizes English and CJK runs without dropping source offsets", () => {
    const source = "I visited 自然历史博物馆.";
    const tokens = tokenizeFactFrameSource(source);
    expect(tokenizeFactFrameWordPieces(source)).toEqual(tokens.map((token) => token.normalized));
    expect(tokens[0]).toMatchObject({ text: "I", start: 0 });
    expect(sliceFactFrameTokens(source, tokens, 0, tokens.length)).toBe("I visited 自然历史博物馆");
  });

  it("skips a leading prepositional adjunct only when the next token is the subject", () => {
    const tokens = tokenizeFactFrameSource("By the way, I cooked pasta.");
    expect(skipLeadingAdjunctSpan(tokens, (index) => tokens[index]?.normalized === "i")).toBeGreaterThan(0);
    expect(skipLeadingAdjunctSpan(tokens, () => false)).toBe(0);
  });

  it("classifies independently anchored declaratives as supported and dependent scope as unsupported", () => {
    expect(classifyFactFrameCertifierSupportDomain("")).toBe("uninterpreted");
    expect(classifyFactFrameCertifierSupportDomain("I bought a bookshelf from Target.")).toBe("supported");
    expect(classifyFactFrameCertifierSupportDomain("I enter the lab if the door is open.")).toBe("unsupported");
    expect(classifyFactFrameCertifierSupportDomain("Something I bought at Target.")).toBe("unsupported");
    expect(classifyFactFrameCertifierSupportDomain("I listened.")).toBe("uninterpreted");
  });

  it("treats unquoted condition cues as dependent scope and quoted cues as opaque text", () => {
    expect(hasUnquotedSourceDependentScope("I enter if the door is open.")).toBe(true);
    expect(hasUnquotedSourceDependentScope('I remember "if only".')).toBe(false);
    expect(isInsideSourceQuotation('I remember "if only".', 13)).toBe(true);
    expect(isInsideSourceQuotation("parents' house", 8)).toBe(false);
  });

  it("compiles a source-bound graph only when the frame preserves source obligations", () => {
    const source = "I use Atlas for research.";
    const frame = normalizer.propose(source)!.fact_frame;
    expect(groundAssociativeFactFrame(frame, source)).toEqual(frame);
    const graph = compileSourceFrameSemanticGraph(source, frame);
    expect(graph).not.toBeNull();
    expect(evidenceFactFrameGraphIsComplete({ source_text: source, fact_frame: frame, graph: graph! })).toBe(true);
    expect(groundEvidenceFactFrameObligation(source, frame)?.predicate.surface).toBe("use");
    expect(compileSourceFrameSemanticGraph(source, {
      schema_version: 1,
      slots: [
        { role: "subject", text: "I" },
        { role: "relation", text: "use" },
        { role: "value", text: "Nova" }
      ]
    })).toBeNull();
    expect(evidenceFactFrameGraphIsComplete({
      source_text: source,
      fact_frame: { not: "a frame" },
      graph: graph!
    })).toBe(false);
  });
});
