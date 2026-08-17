import { describe, expect, it } from "vitest";
import {
  DiagnosticLoopFailure,
  renderDiagnosticLoopFailure,
  renderResumeCommand,
  wrapPhaseError
} from "../../../longmemeval/diagnostic-loop/failures.js";
import { loopRequest } from "./fixture.js";

describe("diagnostic-loop failures", () => {
  it("prints the failed phase and smallest resume command", () => {
    const resume = renderResumeCommand({
      workRoot: "/tmp/loop",
      phase: "snapshot",
      mode: "cache-only",
      argv: ["--work-root", "/tmp/loop", "--mode", "cache-only", "--limit", "1"]
    });
    expect(resume).toBe(
      "alaya-bench-runner diagnostic-loop --work-root /tmp/loop " +
      "--from-phase snapshot --mode cache-only --limit 1"
    );

    const rendered = renderDiagnosticLoopFailure(new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: "snapshot missing",
      resumeCommand: resume
    }));
    expect(rendered).toContain("phase=snapshot");
    expect(rendered).toContain("class=infrastructure");
    expect(rendered).toContain("resume: ");
    expect(rendered).toContain("--from-phase snapshot");
  });

  it("classifies wrapped recall errors as candidate failures", () => {
    const failure = wrapPhaseError({
      phase: "control_recall",
      mode: "run",
      workRoot: "/tmp/loop",
      argv: [],
      request: loopRequest(),
      error: new Error("daemon unavailable")
    });
    expect(failure.classification).toBe("candidate");
    expect(failure.phase).toBe("control_recall");
  });
});
