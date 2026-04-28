import type {
  AlayaRuntimePort,
  AuditedContextPackInput,
  AuditedGovernanceBypassInput,
  AuditedMemorySessionEventInput,
  AuditedProposalRecordInput,
  AuditedProviderSelectionInput,
  AuditedRecallContextInput,
  AuditedTrustSummaryInput
} from "../runtime/types.js";
import type { JsonObject, JsonValue } from "../runtime/json.js";
import { errorToRedactedJson, redactJsonObject, redactJsonValue, redactString } from "../runtime/redaction.js";

const operationSpecs = {
  "doctor.status": {
    runtime_method: "doctor"
  },
  "governance.bypass.detected": {
    runtime_method: "recordGovernanceBypass"
  },
  "provider.proposal.record": {
    runtime_method: "recordProposal"
  },
  "provider.selection.decide": {
    runtime_method: "selectProvider"
  },
  "recall.context.assemble": {
    runtime_method: "assembleRecallContext"
  },
  "recall.context_pack.record": {
    runtime_method: "recordContextPack"
  },
  "session.event.record": {
    runtime_method: "recordMemorySessionEvent"
  },
  "session.trust_summary.generate": {
    runtime_method: "generateTrustSummary"
  }
} as const satisfies Record<string, { readonly runtime_method: keyof AlayaRuntimePort }>;

export type AlayaOperationName = keyof typeof operationSpecs;
export type AlayaOperationTransport = "cli-fallback" | "mcp" | "gateway";

export interface AlayaOperationPayloadMap {
  readonly "doctor.status": JsonObject;
  readonly "governance.bypass.detected": AuditedGovernanceBypassInput;
  readonly "provider.proposal.record": AuditedProposalRecordInput;
  readonly "provider.selection.decide": AuditedProviderSelectionInput;
  readonly "recall.context.assemble": AuditedRecallContextInput;
  readonly "recall.context_pack.record": AuditedContextPackInput;
  readonly "session.event.record": AuditedMemorySessionEventInput;
  readonly "session.trust_summary.generate": AuditedTrustSummaryInput;
}

export type AlayaOperationPayload<Name extends AlayaOperationName> = AlayaOperationPayloadMap[Name];

export interface AlayaOperationContract<Name extends AlayaOperationName = AlayaOperationName> {
  readonly name: "AlayaRuntimeOperation";
  readonly operation: Name;
  readonly runtime_method: (typeof operationSpecs)[Name]["runtime_method"];
  readonly schema_version: 1;
}

export interface NormalizedAlayaOperationRequest<Name extends AlayaOperationName = AlayaOperationName> {
  readonly schema_version: 1;
  readonly transport: AlayaOperationTransport;
  readonly contract: AlayaOperationContract<Name>;
  readonly operation: Name;
  readonly payload: AlayaOperationPayload<Name>;
  readonly redacted_payload: JsonObject;
  readonly command?: readonly string[];
  readonly toolName?: string;
}

export interface OperationParityShape<Name extends AlayaOperationName = AlayaOperationName> {
  readonly schema_version: 1;
  readonly contract: AlayaOperationContract<Name>;
  readonly operation: Name;
  readonly payload: AlayaOperationPayload<Name>;
}

export interface NormalizeCliFallbackRequestInput<Name extends AlayaOperationName = AlayaOperationName> {
  readonly operation: Name;
  readonly payload?: AlayaOperationPayload<Name>;
  readonly command?: readonly string[];
}

export interface NormalizeMcpOperationRequestInput<Name extends AlayaOperationName = AlayaOperationName> {
  readonly operation: Name;
  readonly payload?: AlayaOperationPayload<Name>;
  readonly toolName?: string;
}

export interface CliFallbackSuccessResponse<Name extends AlayaOperationName = AlayaOperationName> {
  readonly schema_version: 1;
  readonly ok: true;
  readonly contract: AlayaOperationContract<Name>;
  readonly operation: Name;
  readonly result: JsonValue;
}

export interface CliFallbackFailureResponse {
  readonly schema_version: 1;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type CliFallbackResponse<Name extends AlayaOperationName = AlayaOperationName> =
  | CliFallbackSuccessResponse<Name>
  | CliFallbackFailureResponse;

export class UnsupportedCliFallbackOperationError extends Error {
  public readonly code = "UNSUPPORTED_OPERATION";

  public constructor(operation: string) {
    super(`Unsupported CLI fallback operation: ${redactString(operation)}.`);
    this.name = "UnsupportedCliFallbackOperationError";
  }
}

export class InvalidCliFallbackPayloadError extends Error {
  public readonly code = "INVALID_PAYLOAD";

  public constructor(operation: string) {
    super(`CLI fallback operation ${redactString(operation)} requires an object payload.`);
    this.name = "InvalidCliFallbackPayloadError";
  }
}

export function normalizeCliFallbackRequest<Name extends AlayaOperationName>(
  input: NormalizeCliFallbackRequestInput<Name>
): NormalizedAlayaOperationRequest<Name> {
  return normalizeOperationRequest({
    operation: input.operation,
    transport: "cli-fallback",
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.payload === undefined ? {} : { payload: input.payload })
  });
}

export function normalizeMcpOperationRequest<Name extends AlayaOperationName>(
  input: NormalizeMcpOperationRequestInput<Name>
): NormalizedAlayaOperationRequest<Name> {
  return normalizeOperationRequest({
    operation: input.operation,
    transport: "mcp",
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName })
  });
}

export function toOperationParityShape<Name extends AlayaOperationName>(
  request: NormalizedAlayaOperationRequest<Name>
): OperationParityShape<Name> {
  return {
    contract: request.contract,
    operation: request.operation,
    payload: request.payload,
    schema_version: request.schema_version
  };
}

export function createCliFallbackSuccessResponse<Name extends AlayaOperationName>(input: {
  readonly request: NormalizedAlayaOperationRequest<Name>;
  readonly result: unknown;
}): CliFallbackSuccessResponse<Name> {
  return {
    contract: input.request.contract,
    ok: true,
    operation: input.request.operation,
    result: redactJsonValue(input.result),
    schema_version: 1
  };
}

export function createCliFallbackFailureResponse(input: {
  readonly error: unknown;
}): CliFallbackFailureResponse {
  const error = input.error;
  const redacted = errorToRedactedJson(error);
  return {
    error: {
      code: inferErrorCode(error),
      message: typeof redacted.message === "string" ? redacted.message : String(redacted.message)
    },
    ok: false,
    schema_version: 1
  };
}

function normalizeOperationRequest<Name extends AlayaOperationName>(input: {
  readonly transport: AlayaOperationTransport;
  readonly operation: Name;
  readonly payload?: AlayaOperationPayload<Name>;
  readonly command?: readonly string[];
  readonly toolName?: string;
}): NormalizedAlayaOperationRequest<Name> {
  const operation = assertSupportedOperation(input.operation);
  const payload = normalizePayload(operation, input.payload);
  const contract = {
    name: "AlayaRuntimeOperation",
    operation,
    runtime_method: operationSpecs[operation].runtime_method,
    schema_version: 1
  } as AlayaOperationContract<Name>;

  return {
    contract,
    operation: operation as Name,
    payload: payload as AlayaOperationPayload<Name>,
    redacted_payload: redactJsonObject(payload),
    schema_version: 1,
    transport: input.transport,
    ...(input.command === undefined ? {} : { command: input.command.map(redactString) }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName })
  };
}

function assertSupportedOperation(operation: string): AlayaOperationName {
  if (Object.hasOwn(operationSpecs, operation)) {
    return operation as AlayaOperationName;
  }
  throw new UnsupportedCliFallbackOperationError(operation);
}

function normalizePayload<Name extends AlayaOperationName>(
  operation: Name,
  payload: AlayaOperationPayload<Name> | undefined
): AlayaOperationPayload<Name> {
  if (payload === undefined) {
    if (operation === "doctor.status") {
      return {} as AlayaOperationPayload<Name>;
    }
    throw new InvalidCliFallbackPayloadError(operation);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new InvalidCliFallbackPayloadError(operation);
  }
  return payload;
}

function inferErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.trim().length > 0
  ) {
    return redactString(error.code);
  }
  return "CLI_FALLBACK_ERROR";
}
