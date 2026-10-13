import { isIP } from "node:net";
import { Agent, EnvHttpProxyAgent, Pool, buildConnector, getGlobalDispatcher, type Dispatcher } from "undici";
import { resolveNativeEnvProxyEnabled } from "../native-env-proxy.js";
import { ProviderChatCompletionError } from "./errors.js";
import { resolveProviderAddressBinding } from "./provider-url-guard.js";
import type { ProviderChatCompletionRequest } from "./types.js";

export async function createProviderTransport(endpoint: string, request: ProviderChatCompletionRequest, signal: AbortSignal): Promise<{
  readonly dispatcher: Dispatcher;
  readonly owned: boolean;
}> {
  const binding = await resolveProviderAddressBinding(endpoint, request.env);
  if (binding === undefined && request.transportFactory === undefined) {
    return { dispatcher: getGlobalDispatcher(), owned: false };
  }
  const factory: NonNullable<Agent.Options["factory"]> = (origin, options) => {
    if (binding === undefined) return new Pool(origin, options);
    if (new URL(origin).origin !== binding.origin) {
      throw new ProviderChatCompletionError("provider transport origin changed after admission", "network_error");
    }
    // Undici's public factory type uses Object; Pool defines the actual options
    // passed by both Agent and ProxyAgent after the proxy branch is selected.
    const poolOptions = options as Pool.Options;
    const connector = typeof poolOptions.connect === "function"
      ? poolOptions.connect : buildConnector(poolOptions.connect ?? {});
    return new Pool(origin, { ...poolOptions, connect(connectOptions, callback) {
      // ProxyAgent's connector uses host for CONNECT, while the direct connector
      // uses hostname. The Pool origin still owns HTTP Host and original TLS SNI.
      connectAdmittedAddress(connector, { ...connectOptions,
        servername: connectOptions.servername ?? (isIP(binding.hostname) === 0 ? binding.hostname : undefined)
      }, binding.addresses, signal, callback);
    } });
  };
  const hostname = binding?.hostname ?? new URL(endpoint).hostname.replace(/^\[|\]$/gu, "");
  const requestTls = { servername: isIP(hostname) === 0 ? hostname : undefined };
  const dispatcher = request.transportFactory?.({ factory, requestTls })
    ?? (resolveNativeEnvProxyEnabled({ env: request.env ?? {}, execArgv: process.execArgv }) === true
      ? new EnvHttpProxyAgent({ factory, requestTls }) : new Agent({ factory }));
  return { dispatcher, owned: true };
}

function connectAdmittedAddress(connector: buildConnector.connector, options: buildConnector.Options,
  addresses: readonly string[], signal: AbortSignal, callback: buildConnector.Callback): void {
  const attempt = (index: number): void => {
    if (signal.aborted) {
      callback(new ProviderChatCompletionError("provider connection aborted", "aborted", null, { cause: signal.reason }), null);
      return;
    }
    const hostname = addresses[index]!;
    const address = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    connector({ ...options, hostname, host: `${address}${options.port ? `:${options.port}` : ""}` }, (error, socket) => {
      if (error !== null) {
        // Only connection establishment retries, against the same admitted set.
        // No HTTP bytes have been sent, and DNS is never consulted again.
        if (index + 1 < addresses.length && !signal.aborted) attempt(index + 1);
        else callback(error, null);
      } else if (signal.aborted) {
        socket.destroy();
        callback(new ProviderChatCompletionError("provider connection aborted", "aborted", null, { cause: signal.reason }), null);
      } else callback(null, socket);
    });
  };
  attempt(0);
}
