import { describe, expect, it } from "vitest";
import { INSPECTOR_LAUNCH_PROOF_FD, readInspectorLaunchProof } from "../../launch/launch-proof.js";

describe("inspector launch proof", () => {
  it("reads the inherited fd", () => {
    expect(
      readInspectorLaunchProof((fd) => {
        expect(fd).toBe(INSPECTOR_LAUNCH_PROOF_FD);
        return "from-fd\n";
      })
    ).toBe("from-fd");
  });

  it("does not fall back to the environment when the inherited fd is unavailable", () => {
    expect(
      readInspectorLaunchProof(() => {
        throw new Error("EBADF");
      })
    ).toBeUndefined();
  });
});
