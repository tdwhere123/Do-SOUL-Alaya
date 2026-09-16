import { describe, expect, it } from "vitest";
import { INSPECTOR_LAUNCH_PROOF_FD, readInspectorLaunchProof } from "../../launch/launch-proof.js";

describe("inspector launch proof", () => {
  it("prefers the inherited fd over an environment value", () => {
    expect(
      readInspectorLaunchProof(
        { ALAYA_INSPECTOR_LAUNCH_CODE: "from-env" },
        (fd) => {
          expect(fd).toBe(INSPECTOR_LAUNCH_PROOF_FD);
          return "from-fd\n";
        }
      )
    ).toBe("from-fd");
  });

  it("falls back to the environment when the inherited fd is unavailable", () => {
    expect(
      readInspectorLaunchProof(
        { ALAYA_INSPECTOR_LAUNCH_CODE: "from-env" },
        () => {
          throw new Error("EBADF");
        }
      )
    ).toBe("from-env");
  });
});
