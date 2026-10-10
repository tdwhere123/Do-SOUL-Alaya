/** Install the shared isolation owner before Node imports the bench CLI. */
import { installProviderFreeBoundary } from "./provider-free-boundary.ts";

const isolation = installProviderFreeBoundary();
// A caught refusal must still fail the child, not masquerade as a successful replay.
process.on("exit", () => {
  if (isolation.violations.length > 0) process.exitCode = 1;
});
process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:E0_TEST_GARDEN_KEY";
process.env.E0_TEST_GARDEN_KEY = "test-key";
