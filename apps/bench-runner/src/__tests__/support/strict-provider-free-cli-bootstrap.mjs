/** Install the same strict test owner before native worker application imports. */
import { installProviderFreeBoundary } from "./provider-free-boundary.ts";
import { installStrictProviderFreeBoundary } from "./strict-provider-free-boundary.ts";

const safe = installProviderFreeBoundary();
const strict = installStrictProviderFreeBoundary();
process.on("exit", () => {
  if (safe.violations.length > 0 || strict.forbidden.length > 0) process.exitCode = 1;
});
