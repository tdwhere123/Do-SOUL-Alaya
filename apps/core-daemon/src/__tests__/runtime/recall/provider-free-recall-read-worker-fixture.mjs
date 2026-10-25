// The real shipped worker, with guards installed before any application import.
import { installProviderFreeBoundary } from "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.ts";
installProviderFreeBoundary();
globalThis.fetch = () => { throw new Error("provider transport forbidden in recall worker test"); };
await import("../../../../dist/runtime/recall/recall-read-worker.js");
