import { describe, expect, it } from "vitest";
import { formatTransportDiagnostic } from "../../../runs/extraction/fill/transport-diagnostic.js";

const UNKNOWN = "transport_observation stage=unknown observed_codes=unknown";

describe("bounded private transport observations", () => {
  it("observes wrapped and aggregate literal codes without asserting a stage or root cause", () => {
    const error = new Error("secret message", { cause: new AggregateError([
      { code: "ECONNREFUSED" }, { code: "UND_ERR_SOCKET" }, { code: "ECONNREFUSED" }
    ], "secret aggregate") });
    expect(formatTransportDiagnostic(error)).toBe(
      "transport_observation stage=unknown observed_codes=ECONNREFUSED,UND_ERR_SOCKET");
  });

  it("never invokes getters, prototype traps, coercion, or supplied iterators", () => {
    let effects = 0;
    const fail = () => { effects += 1; throw new Error("secret-side-effect"); };
    const hostile = Object.create(new Proxy({}, { get: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail }));
    for (const key of ["code", "cause", "errors", "message", "stack", "name"]) {
      Object.defineProperty(hostile, key, { get: fail });
    }
    const children = [{ code: "ECONNRESET" }];
    Object.defineProperty(children, Symbol.iterator, { value: fail });
    Object.defineProperty(children, "1", { get: fail });
    expect(formatTransportDiagnostic(hostile)).toBe(UNKNOWN);
    expect(formatTransportDiagnostic({ code: { toString: fail, [Symbol.toPrimitive]: fail }, errors: children }))
      .toBe("transport_observation stage=unknown observed_codes=ECONNRESET");
    expect(effects).toBe(0);
  });

  it("rejects proxies before reflection, including revoked object, array and function proxies", () => {
    let effects = 0;
    const trap = () => { effects += 1; throw new Error("secret-proxy"); };
    const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    for (const target of [{}, [], () => undefined]) {
      const revoked = Proxy.revocable(target, {});
      revoked.revoke();
      expect(formatTransportDiagnostic(revoked.proxy)).toBe(UNKNOWN);
      expect(formatTransportDiagnostic({ errors: revoked.proxy })).toBe(UNKNOWN);
      expect(formatTransportDiagnostic({ cause: revoked.proxy })).toBe(UNKNOWN);
    }
    expect(formatTransportDiagnostic(proxy)).toBe(UNKNOWN);
    expect(effects).toBe(0);
  });

  it("does not expose secret strings, unallowlisted codes, inherited codes or arbitrary primitives", () => {
    const secret = "secret-marker:https://private.invalid Authorization bearer credential";
    for (const value of [undefined, null, true, 7, 1n, Symbol(secret), secret,
      { code: secret, message: secret, stack: secret, address: secret, headers: secret, body: secret },
      Object.create({ code: "ECONNRESET" }), { code: new String("ECONNRESET") },
      { code: "ECONNRESET\n" }, { code: "econnreset" }]) {
      expect(formatTransportDiagnostic(value)).toBe(UNKNOWN);
    }
  });

  it("bounds cause traversal to four edges and handles identity cycles", () => {
    const cycle: { code: string; cause?: unknown; errors?: unknown[] } = { code: "ETIMEDOUT" };
    cycle.cause = cycle;
    cycle.errors = [cycle];
    expect(formatTransportDiagnostic(cycle)).toBe("transport_observation stage=unknown observed_codes=ETIMEDOUT");
    let chain: object = { code: "ECONNREFUSED" };
    for (let i = 0; i < 4; i += 1) chain = { cause: chain };
    expect(formatTransportDiagnostic(chain)).toContain("observed_codes=ECONNREFUSED");
    expect(formatTransportDiagnostic({ cause: chain })).toBe(UNKNOWN);
  });

  it("bounds aggregate indices, visited objects and output independently of input size", () => {
    const huge: unknown[] = [];
    huge.length = 2 ** 32 - 1;
    huge[4] = { code: "ECONNRESET" };
    Object.defineProperty(huge, "3", { get: () => { throw new Error("must not read getter"); } });
    expect(formatTransportDiagnostic({ errors: huge })).toBe(UNKNOWN);
    // Root + array + four children + first two causes consumes all eight visits.
    const children = [0, 1, 2, 3].map(index => ({ cause: index < 2 ? {} : { code: "ECONNRESET" } }));
    expect(formatTransportDiagnostic({ errors: children })).toBe(UNKNOWN);
    const text = formatTransportDiagnostic({ code: "ECONNREFUSED", errors: [
      { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, { code: "UND_ERR_HEADERS_TIMEOUT" }
    ] });
    expect(text).toBe("transport_observation stage=unknown observed_codes=ECONNREFUSED,UNABLE_TO_VERIFY_LEAF_SIGNATURE,ERR_TLS_CERT_ALTNAME_INVALID,DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256);
  });
});
