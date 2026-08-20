export const BENCH_ENV_PROXY_BOOTSTRAPPED = "ALAYA_BENCH_ENV_PROXY_BOOTSTRAPPED";

export interface BenchCliEnvProxyBootstrapPlan {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export function planBenchCliEnvProxyBootstrap(input: {
  readonly argv: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly execArgv: readonly string[];
  readonly entryPath: string;
  readonly supportsEnvProxy: boolean;
}): BenchCliEnvProxyBootstrapPlan | null {
  if (!hasConfiguredProxy(input.env) || envProxyAlreadyEnabled(input)) return null;
  if (!input.supportsEnvProxy) {
    throw new Error("active Node runtime does not support --use-env-proxy");
  }
  return Object.freeze({
    argv: Object.freeze(["--use-env-proxy", input.entryPath, ...input.argv]),
    env: {
      ...input.env,
      [BENCH_ENV_PROXY_BOOTSTRAPPED]: "1"
    }
  });
}

function hasConfiguredProxy(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

function envProxyAlreadyEnabled(input: {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly execArgv: readonly string[];
}): boolean {
  return input.env[BENCH_ENV_PROXY_BOOTSTRAPPED] === "1" ||
    input.env.NODE_USE_ENV_PROXY === "1" ||
    input.execArgv.includes("--use-env-proxy");
}
