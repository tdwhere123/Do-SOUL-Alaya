import { describe, expect, it } from "vitest";
import {
  ENV_BOOLEAN_FALSE_TOKENS,
  ENV_BOOLEAN_TRUE_TOKENS,
  ENV_BOOLEAN_VOCABULARY_ERROR
} from "@do-soul/alaya-protocol";
import { assertInspectDaemonUrl } from "../../../cli/inspect/inspect-daemon-client.js";
import {
  ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV,
  ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV,
  resolveEdgeClassifyWiring
} from "../../../runtime/daemon/lifecycle/daemon-runtime-support.js";
import { validateDaemonEnv } from "../../../runtime/daemon/support/daemon-env.js";
import { shouldEnableE2eEventTriggers } from "../../../runtime/daemon/wiring/daemon-app-composition.js";
import {
  isRemoteDaemonOptInEnabled,
  isWildcardBindOptInEnabled
} from "../../../runtime/server-options.js";

const VOCABULARY_ERROR = new RegExp(ENV_BOOLEAN_VOCABULARY_ERROR);

describe("public env boolean vocabulary", () => {
  it.each([...ENV_BOOLEAN_TRUE_TOKENS])("treats %j as true on public flags", (token) => {
    expect(isRemoteDaemonOptInEnabled({ ALAYA_ALLOW_REMOTE_DAEMON: token })).toBe(true);
    expect(isWildcardBindOptInEnabled({ ALAYA_ALLOW_WILDCARD_BIND: token })).toBe(true);
    expect(() => validateDaemonEnv({ ALAYA_ALLOW_REMOTE_DAEMON: token })).not.toThrow();
    expect(() => validateDaemonEnv({ ALAYA_ALLOW_WILDCARD_BIND: token })).not.toThrow();
    expect(() =>
      assertInspectDaemonUrl("http://evil.example:5173", { ALAYA_ALLOW_REMOTE_DAEMON: token })
    ).not.toThrow();
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: token
      })
    ).toBe(true);
    expect(
      resolveEdgeClassifyWiring(
        { [ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]: token },
        { provider_kind: "official_api" }
      ).llmEnabled
    ).toBe(true);
    expect(
      resolveEdgeClassifyWiring(
        { [ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]: token },
        { provider_kind: "official_api" }
      ).hostWorkerEnabled
    ).toBe(true);
  });

  it.each([...ENV_BOOLEAN_FALSE_TOKENS])("treats %j as false on public flags", (token) => {
    expect(isRemoteDaemonOptInEnabled({ ALAYA_ALLOW_REMOTE_DAEMON: token })).toBe(false);
    expect(isWildcardBindOptInEnabled({ ALAYA_ALLOW_WILDCARD_BIND: token })).toBe(false);
    expect(() => validateDaemonEnv({ ALAYA_ALLOW_REMOTE_DAEMON: token })).not.toThrow();
    expect(
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: token
      })
    ).toBe(false);
    expect(
      resolveEdgeClassifyWiring(
        { [ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]: token },
        { provider_kind: "official_api" }
      ).llmEnabled
    ).toBe(false);
  });

  it("rejects 2 on every public flag reader", () => {
    expect(() => isRemoteDaemonOptInEnabled({ ALAYA_ALLOW_REMOTE_DAEMON: "2" }))
      .toThrow(VOCABULARY_ERROR);
    expect(() => isWildcardBindOptInEnabled({ ALAYA_ALLOW_WILDCARD_BIND: "2" }))
      .toThrow(VOCABULARY_ERROR);
    expect(() => validateDaemonEnv({ ALAYA_ALLOW_REMOTE_DAEMON: "2" }))
      .toThrow(VOCABULARY_ERROR);
    expect(() => validateDaemonEnv({ ALAYA_ALLOW_WILDCARD_BIND: "2" }))
      .toThrow(VOCABULARY_ERROR);
    expect(() =>
      assertInspectDaemonUrl("http://evil.example:5173", { ALAYA_ALLOW_REMOTE_DAEMON: "2" })
    ).toThrow(VOCABULARY_ERROR);
    expect(() =>
      shouldEnableE2eEventTriggers({
        NODE_ENV: "test",
        ALAYA_ENABLE_E2E_EVENT_TRIGGERS: "2"
      })
    ).toThrow(VOCABULARY_ERROR);
    expect(() =>
      resolveEdgeClassifyWiring(
        { [ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]: "2" },
        { provider_kind: "official_api" }
      )
    ).toThrow(VOCABULARY_ERROR);
    expect(() =>
      resolveEdgeClassifyWiring(
        { [ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]: "2" },
        { provider_kind: "official_api" }
      )
    ).toThrow(VOCABULARY_ERROR);
  });
});
