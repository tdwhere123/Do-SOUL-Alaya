import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { RECALL_RETENTION_TTL_MS } from "@do-soul/alaya-core";
import { RecallDeliveryRoutes } from "../../../runtime/recall/recall-delivery-routes.js";
import { semanticLeaseExpiry } from "../../../runtime/recall-read-worker/source-semantic-leases.js";

afterEach(() => vi.useRealTimers());

it("keeps every admitted execution route beyond the former count cap and expires idle handles", () => {
  vi.useFakeTimers();
  const routes = new RecallDeliveryRoutes();
  const worker = {} as Worker;
  for (let index = 0; index < 300; index++) routes.set(`execution-${index}`, worker);
  expect([...routes]).toHaveLength(300);
  expect(routes.get("execution-0")).toBe(worker);
  routes.delete("execution-1");
  expect(routes.get("execution-1")).toBeUndefined();
  vi.advanceTimersByTime(RECALL_RETENTION_TTL_MS);
  expect([...routes]).toEqual([]);
});

it("preserves the source semantic owner's longer admitted lease", () => {
  vi.useFakeTimers();
  const routes = new RecallDeliveryRoutes();
  const worker = {} as Worker;
  routes.set("query-handle", worker, Date.parse(semanticLeaseExpiry(new Date().toISOString())));
  vi.advanceTimersByTime(6 * 60_000);
  expect(routes.get("query-handle")).toBe(worker);
  vi.advanceTimersByTime(4 * 60_000);
  expect(routes.get("query-handle")).toBeUndefined();
});
