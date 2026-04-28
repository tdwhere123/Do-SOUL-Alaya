/**
 * Shared test fixture factories for Anthropic Agent SDK message shapes.
 *
 * Each factory uses `satisfies` to anchor the fixture against the official SDK type
 * at compile time, ensuring SDK type regressions surface as build errors.
 *
 * UUIDs are parameterized so each test file can use its own distinct values
 * while still benefiting from the shared construction logic.
 */

type OfficialSDKFilesPersistedEvent = import("@anthropic-ai/claude-agent-sdk").SDKFilesPersistedEvent;
type OfficialSDKPartialAssistantMessage = import("@anthropic-ai/claude-agent-sdk").SDKPartialAssistantMessage;
type OfficialSDKResultError = import("@anthropic-ai/claude-agent-sdk").SDKResultError;
type OfficialSDKResultMessage = import("@anthropic-ai/claude-agent-sdk").SDKResultMessage;
type OfficialSDKResultSuccess = import("@anthropic-ai/claude-agent-sdk").SDKResultSuccess;

/** The SDK's UUID template-literal type (`${string}-${string}-${string}-${string}-${string}`). */
type SDKUuid = OfficialSDKPartialAssistantMessage["uuid"];

export function makePartialAssistantMessage(
  text: string,
  uuid: SDKUuid = "00000000-0000-4000-8000-000000000001"
): OfficialSDKPartialAssistantMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text
      }
    },
    parent_tool_use_id: null,
    session_id: "sdk-session-1",
    uuid
  } satisfies OfficialSDKPartialAssistantMessage;
}

export function makeResultMessage(result: string, uuid: SDKUuid = "00000000-0000-4000-8000-000000000002"): OfficialSDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result,
    stop_reason: null,
    total_cost_usd: 0,
    usage: makeUsage(),
    modelUsage: {},
    permission_denials: [],
    session_id: "sdk-session-1",
    uuid
  } satisfies OfficialSDKResultSuccess;
}

export function makeResultErrorMessage(
  errors: readonly string[],
  subtype: OfficialSDKResultError["subtype"] = "error_during_execution",
  uuid: SDKUuid = "00000000-0000-4000-8000-000000000011"
): OfficialSDKResultError {
  return {
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: makeUsage(),
    modelUsage: {},
    permission_denials: [],
    errors: [...errors],
    session_id: "sdk-session-1",
    uuid
  } satisfies OfficialSDKResultError;
}

export function makeFilesPersistedMessage(
  filename: string,
  uuid: SDKUuid = "00000000-0000-4000-8000-000000000003"
): OfficialSDKFilesPersistedEvent {
  return {
    type: "system",
    subtype: "files_persisted",
    files: [
      {
        file_id: "file-1",
        filename
      }
    ],
    failed: [],
    processed_at: "2026-04-13T10:00:00.000Z",
    uuid,
    session_id: "sdk-session-1"
  } satisfies OfficialSDKFilesPersistedEvent;
}

/**
 * Returns a minimal NonNullableUsage fixture. The adapter never reads usage fields,
 * so only scalar zero-values are provided; complex nested fields use a cast.
 */
function makeUsage(): OfficialSDKResultMessage["usage"] {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null as unknown as OfficialSDKResultMessage["usage"]["cache_creation"],
    inference_geo: "",
    iterations: null as unknown as OfficialSDKResultMessage["usage"]["iterations"],
    server_tool_use: null as unknown as OfficialSDKResultMessage["usage"]["server_tool_use"],
    service_tier: "standard",
    speed: null as unknown as OfficialSDKResultMessage["usage"]["speed"]
  } satisfies OfficialSDKResultMessage["usage"];
}
