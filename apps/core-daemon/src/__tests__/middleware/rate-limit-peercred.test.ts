import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  readUnixPeerCredentials,
  resolvePeerRateLimitKey
} from "../../middleware/rate-limit.js";

describe("unix peer credentials", () => {
  it("keys the fail bucket as unix:uid:pid when libuv peercred is present", () => {
    const context = {
      env: {
        incoming: {
          socket: {
            _handle: {
              getPeerCredentials: () => ({ uid: 501, pid: 4242 })
            }
          }
        }
      }
    } as Context;
    expect(readUnixPeerCredentials(context)).toBe("501:4242");
    expect(resolvePeerRateLimitKey(context)).toBe("unix:501:4242");
  });

  it("returns undefined when libuv does not expose peercred", () => {
    const context = {
      env: {
        incoming: {
          socket: {
            _handle: {}
          }
        }
      }
    } as Context;
    expect(readUnixPeerCredentials(context)).toBeUndefined();
  });
});
