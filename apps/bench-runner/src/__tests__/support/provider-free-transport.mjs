import net from "node:net";
import http from "node:http";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import { isKernelWriteLeaseIpcAddress } from "../../runs/extraction/fill/manifest/kernel-write-lease-ipc.mjs";

/** Guard native Node transports: fetch alone does not cover http, sockets or DNS. */
export function installProviderFreeTransport(deny) {
  const restores = [];
  const replace = (owner, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (typeof Reflect.get(owner, key) !== "function") return;
    Object.defineProperty(owner, key, descriptor && "value" in descriptor ? { ...descriptor, value }
      : { configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value });
    restores.push(() => { if (descriptor) Object.defineProperty(owner, key, descriptor); else Reflect.deleteProperty(owner, key); });
  };
  const connect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, "connect", new Proxy(connect, {
    apply(target, receiver, args) {
      const normalized = Array.isArray(args[0]) ? args[0] : undefined;
      const value = normalized ? normalized[0] : args[0];
      if (typeof value === "string") {
        if (isKernelWriteLeaseIpcAddress(value)) return Reflect.apply(target, receiver, args);
        if (!/^\d+$/u.test(value)) return deny("non-loopback socket");
      }
      let options;
      if (typeof value === "number" || typeof value === "string" && /^\d+$/u.test(value)) {
        options = { port: Number(value), host: typeof args[1] === "string" ? args[1] : undefined };
      } else if (value && typeof value === "object") options = { ...value };
      else return deny("unknown socket destination");
      if (typeof options.path === "string" && options.path.length > 0) {
        if (!isKernelWriteLeaseIpcAddress(options.path)) return deny("non-loopback socket");
        return Reflect.apply(target, receiver, args);
      }
      const host = options.host ?? options.hostname ?? "localhost";
      if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") return deny("non-loopback socket");
      options.host = host === "localhost" ? "127.0.0.1" : host;
      delete options.hostname; delete options.lookup;
      if (normalized) {
        const copy = Object.assign([...normalized], normalized); copy[0] = options; args[0] = copy;
      } else if (typeof value === "number" || typeof value === "string") {
        args = [options, ...args.slice(1).filter((arg) => typeof arg === "function")];
      } else args[0] = options;
      return Reflect.apply(target, receiver, args);
    }
  }));
  const emit = http.ClientRequest.prototype.emit;
  replace(http.ClientRequest.prototype, "emit", function (event, ...args) {
    if (event === "response") {
      const response = args[0];
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400 && response.headers.location) {
        try { deny("HTTP redirect"); }
        catch (error) { this.destroy(error); response.destroy(); return false; }
      }
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  replace(dgram, "createSocket", () => deny("UDP transport"));
  replace(http2, "connect", () => deny("HTTP/2 transport"));
  for (const owner of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(owner)) {
      if (/^(?:lookup|resolve|reverse)/u.test(key) && typeof Reflect.get(owner, key) === "function") {
        const lookup = Reflect.get(owner, key);
        replace(owner, key, new Proxy(lookup, { apply(target, receiver, args) {
          if (key === "lookup" && (args[0] === "127.0.0.1" || args[0] === "::1")) return Reflect.apply(target, receiver, args);
          return deny("DNS lookup");
        } }));
      }
    }
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
