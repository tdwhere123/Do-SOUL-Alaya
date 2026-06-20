import type { AlayaDaemonRuntime } from "../index.js";
import { resolveSecretRef, type ResolvedSecret, type ResolveSecretError } from "../secrets/index.js";
import type { GardenComputeStatus, GardenKeychainCheck } from "./doctor.js";
import {
  parseSecretRefKeychainTarget,
  SECRET_REF_ENV_PREFIX,
  SECRET_REF_FILE_PREFIX,
  secretRefScheme
} from "@do-soul/alaya-protocol";

type GardenSecretRefResolution = ResolvedSecret | ResolveSecretError;

/**
 * Derive the Garden compute snapshot the doctor command reports.
 *
 * Reading the saved RuntimeGardenComputeConfig (via configService) gives us
 * provider_kind / model_id / provider_url. The credential_source needs raw
 * env so we can distinguish the dedicated Garden key from an embedding key.
 * routing_decision stays separate from provider_kind so official_api can
 * degrade to local_heuristics when credentials are missing.
 */
export async function resolveGardenComputeStatus(
  runtime: AlayaDaemonRuntime
): Promise<GardenComputeStatus> {
  const config = await runtime.services.configService.getRuntimeGardenComputeConfig();
  const provenance = await runtime.services.configService.getGardenCredentialProvenance();
  // For keychain refs `resolveSecretRef` triggers a platform subprocess
  // (`security` / `secret-tool` / PowerShell). The doctor pass needs the
  // result for both `routing_decision` and `keychain_check`, so resolve
  // at most once per pass and thread it to both consumers — a locked or
  // missing keychain entry must not pay double cost to be reported.
  const resolved: GardenSecretRefResolution | null =
    config.secret_ref === null ? null : resolveSecretRef(config.secret_ref);
  const credential =
    provenance.kind === "embedding-fallback"
      ? ({ kind: "embedding-fallback" } as const)
      : resolveGardenCredentialSource(config.secret_ref);
  return {
    provider_kind: config.provider_kind,
    model_id: config.model_id,
    provider_url: config.provider_url,
    credential_source: credential,
    routing_decision: deriveGardenRoutingDecision(config, resolved),
    ...keychainCheckField(config.secret_ref, resolved),
    ...hostWorkerAdvisoryField(config.provider_kind, runtime)
  };
}

// Under the host_worker product default, surface whether recall-driven
// host-worker work (POST_TURN_EXTRACT and EDGE_CLASSIFY) is waiting for an
// attached CLI agent (LLM quality) or being left to the zero-cloud heuristic
// fallback. Omitted for every other provider_kind, and omitted when no garden
// task repo is wired (non-sqlite harness).
function hostWorkerAdvisoryField(
  providerKind: GardenComputeStatus["provider_kind"],
  runtime: AlayaDaemonRuntime
): Pick<GardenComputeStatus, "host_worker_advisory"> {
  if (providerKind !== "host_worker") {
    return {};
  }
  const backlog = runtime.services.gardenStatus.getHostWorkerExtractBacklog();
  if (backlog === null) {
    return {};
  }
  return {
    host_worker_advisory: {
      pending_extract_tasks: backlog.pending,
      stale_claimed_extract_tasks: backlog.stale,
      pending_edge_classify_tasks: backlog.edgeClassifyPending,
      stale_claimed_edge_classify_tasks: backlog.edgeClassifyStale,
      attach_worker_recommended: backlog.pending > 0 || backlog.edgeClassifyPending > 0
    }
  };
}

function deriveGardenRoutingDecision(
  config: Awaited<ReturnType<AlayaDaemonRuntime["services"]["configService"]["getRuntimeGardenComputeConfig"]>>,
  resolved: GardenSecretRefResolution | null
): GardenComputeStatus["routing_decision"] {
  if (config.provider_kind !== "official_api") {
    return config.provider_kind;
  }

  if (resolved === null) {
    return "local_heuristics";
  }

  return "kind" in resolved ? "local_heuristics" : "official_api";
}

function keychainCheckField(
  secretRef: string | null,
  resolved: GardenSecretRefResolution | null
): Pick<GardenComputeStatus, "keychain_check"> {
  if (secretRef === null || !secretRef.startsWith("keychain:")) {
    return {};
  }
  const parsed = parseSecretRefKeychainTarget(secretRef);
  if (parsed === null) {
    return buildMalformedKeychainCheck();
  }
  if (resolved !== null && !("kind" in resolved)) {
    return buildSuccessfulKeychainCheck(parsed.service, parsed.account);
  }
  return buildFailedKeychainCheck(
    parsed.service,
    parsed.account,
    resolveKeychainCheckError(secretRef, resolved)
  );
}

function keychainErrorKind(
  error: ResolveSecretError
): Extract<GardenKeychainCheck, { readonly ok: false }>["error_kind"] {
  switch (error.kind) {
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
    case "empty":
    case "malformed":
      return error.kind;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
      return "malformed";
  }
}

function keychainRemediation(error: ResolveSecretError): string {
  switch (error.kind) {
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return error.reason;
    case "empty":
      return "The keychain entry exists but its stored secret is empty.";
    case "malformed":
      return error.reason;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
      return "Configured Garden secret_ref is not a keychain reference.";
  }
}

function buildMalformedKeychainCheck(): Pick<GardenComputeStatus, "keychain_check"> {
  return {
    keychain_check: {
      ok: false,
      service: "",
      account: "",
      error_kind: "malformed",
      remediation:
        "Keychain secret_ref must match keychain:<service>:<account> with each segment limited to [A-Za-z0-9._-]+."
    }
  };
}

function buildSuccessfulKeychainCheck(service: string, account: string): Pick<GardenComputeStatus, "keychain_check"> {
  return {
    keychain_check: {
      ok: true,
      service,
      account
    }
  };
}

function resolveKeychainCheckError(
  secretRef: string,
  resolved: GardenSecretRefResolution | null
): ResolveSecretError {
  return resolved === null
    ? { kind: "malformed", ref: secretRef, reason: "keychain secret_ref was not resolved during this doctor pass." }
    : resolved as ResolveSecretError;
}

function buildFailedKeychainCheck(
  service: string,
  account: string,
  error: ResolveSecretError
): Pick<GardenComputeStatus, "keychain_check"> {
  return {
    keychain_check: {
      ok: false,
      service,
      account,
      error_kind: keychainErrorKind(error),
      remediation: keychainRemediation(error)
    }
  };
}

function resolveGardenCredentialSource(
  secretRef: string | null
): GardenComputeStatus["credential_source"] {
  if (secretRef === null || secretRef === "") {
    // No dedicated Garden secret_ref. Embedding fallback only kicks in when
    // the deprecated path was the active source — getRuntimeGardenComputeConfig
    // surfaces that as a non-null secret_ref starting with "env:", "file:",
    // or "keychain:",
    // so a null here means Garden has no key at all.
    return { kind: "none" };
  }
  switch (secretRefScheme(secretRef)) {
    case "env":
      return { kind: "env", name: secretRef.slice(SECRET_REF_ENV_PREFIX.length) };
    case "file":
      return { kind: "file", masked_path: maskPath(secretRef.slice(SECRET_REF_FILE_PREFIX.length)) };
    case "keychain": {
      const parsed = parseSecretRefKeychainTarget(secretRef);
      if (parsed !== null) {
        return { kind: "keychain", service: parsed.service, account: parsed.account };
      }
      return { kind: "none" };
    }
    case null:
      return { kind: "none" };
  }
}

function maskPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return path;
  }
  return `…/${segments[segments.length - 1]}`;
}
