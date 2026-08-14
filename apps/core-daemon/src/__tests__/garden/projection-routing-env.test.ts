import { describe, expect, it } from "vitest";
import { readProjectionRoutingEnabled } from
  "../../runtime/recall-materialization/recall-materialization-router.js";

describe("write-side projection routing env", () => {
  it("does not treat ALAYA_RECALL_PROJECTIONS as the write-side routing switch", () => {
    expect(readProjectionRoutingEnabled({})).toBe(false);
    expect(readProjectionRoutingEnabled({ ALAYA_RECALL_PROJECTIONS: "on" })).toBe(false);
    expect(readProjectionRoutingEnabled({ ALAYA_RECALL_PROJECTIONS: "1" })).toBe(false);
  });

  it("enables write-side routing only from ALAYA_RECALL_PROJECTION_ROUTING", () => {
    expect(readProjectionRoutingEnabled({ ALAYA_RECALL_PROJECTION_ROUTING: "on" })).toBe(true);
    expect(readProjectionRoutingEnabled({ ALAYA_RECALL_PROJECTION_ROUTING: "1" })).toBe(true);
    expect(readProjectionRoutingEnabled({ ALAYA_RECALL_PROJECTION_ROUTING: "off" })).toBe(false);
  });
});
