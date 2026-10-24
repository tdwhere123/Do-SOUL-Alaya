import { expect, it } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { claimDeliverySettlement, createDeliverySettlement, finishDeliverySettlement } from "../../../runtime/recall-read-worker/delivery-settlement.js";

it("lets cancellation win only before the atomic issuance claim", () => {
  const early = new AbortController();
  const cancelled = createDeliverySettlement(early.signal);
  early.abort();
  expect(claimDeliverySettlement(cancelled.buffer)).toBe(false);
  cancelled.dispose();
  const late = new AbortController();
  const issuing = createDeliverySettlement(late.signal);
  expect(claimDeliverySettlement(issuing.buffer)).toBe(true);
  late.abort();
  finishDeliverySettlement(issuing.buffer, true);
  expect(() => claimDeliverySettlement(issuing.buffer)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  issuing.dispose();
});

it.each([true, false])("refuses a consumed arbitration claim as a domain conflict after committed=%s", committed => {
  const settlement = createDeliverySettlement();
  expect(claimDeliverySettlement(settlement.buffer)).toBe(true);
  expect(() => claimDeliverySettlement(settlement.buffer)).toThrow(CoreError);
  finishDeliverySettlement(settlement.buffer, committed);
  expect(() => claimDeliverySettlement(settlement.buffer)).toThrow(expect.objectContaining({ code: "CONFLICT",
    message: "Recall acknowledgment arbitration already consumed" }));
  settlement.dispose();
});
