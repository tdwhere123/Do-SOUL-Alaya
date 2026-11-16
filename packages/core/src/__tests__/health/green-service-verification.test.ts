import { expectTypeOf, it } from "vitest";
import type { GreenService } from "../../health/green-service.js";
import type { GreenVerificationInput } from "../../health/green-service-verification.js";

it("verification depends only on event delivery and the owning grant/pierce signatures", () => {
  expectTypeOf<keyof GreenVerificationInput["dependencies"]>()
    .toEqualTypeOf<"eventLogRepo" | "runtimeNotifier">();
  expectTypeOf<GreenVerificationInput["grant"]>().toEqualTypeOf<GreenService["grant"]>();
  expectTypeOf<GreenVerificationInput["pierce"]>().toEqualTypeOf<GreenService["pierce"]>();
});
