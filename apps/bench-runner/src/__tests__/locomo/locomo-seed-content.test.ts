import { describe, expect, it } from "./locomo-runner.test-support.js";
import { buildLocomoSeedContent } from "../../locomo/runner.js";

describe("buildLocomoSeedContent", () => {
  const baseTurn = { speaker: "Alice", dia_id: "d1", text: "take a look at this" };

  it("leaves a caption-less turn byte-identical to speaker:text", () => {
    expect(buildLocomoSeedContent({ ...baseTurn })).toBe("Alice: take a look at this");
  });

  it("splices blip_caption and image query when present", () => {
    expect(
      buildLocomoSeedContent({
        ...baseTurn,
        blip_caption: "a sunrise oil painting",
        query: "what is in the photo"
      })
    ).toBe(
      "Alice: take a look at this [image: a sunrise oil painting] [image query: what is in the photo]"
    );
  });

  it("splices only the caption when the image query is absent", () => {
    expect(
      buildLocomoSeedContent({ ...baseTurn, blip_caption: "pottery workshop" })
    ).toBe("Alice: take a look at this [image: pottery workshop]");
  });
});
