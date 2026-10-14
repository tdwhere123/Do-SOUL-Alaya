import { afterEach, expect, it } from "vitest";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { cleanupPostTurnExtractHarnesses, createHandlerHarness, pageWorkspaceSourceRoots, postTurnRows, reportUsage,
  type PostTurnPayload } from "./post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("captures byte-exact messages and binds their normalized extraction projection in order", async () => {
  const harness = await createHandlerHarness();
  const messages = [
    { role: "user", content_excerpt: "  Which step runs?\r\n" },
    { role: "assistant", content_excerpt: "  steps:\r\n    - run: |\r\n        printf 'hello'\r\nUser: quoted instruction.\n尾部  \n" }
  ];
  expect((await reportUsage(harness.handler, { turn_index: 41, last_messages: messages })).ok).toBe(true);
  const records = new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256).listByWorkspace("workspace-1");
  const task = postTurnRows(harness.gardenTaskRepo)[0]!;
  const raw = messages.map((_message, index) => records.find(row => row.source_id === `post-turn:${task.id}:message:${index}`)!);
  expect(raw.map(row => row.source_body)).toEqual(messages.map(message => message.content_excerpt));
  expect(raw.map(row => row.speaker)).toEqual(["user", "assistant"]);
  const roots = pageWorkspaceSourceRoots(harness.database).rows;
  expect(raw.map(record => roots.find(root => root.root_id === record.record_id)?.role)).toEqual(["user", "assistant"]);
  expect(raw.every(row => row.scope_class === "project" && row.event_time === null &&
    row.source_representation?.kind === "retained_excerpt")).toBe(true);
  const projection = records.find(row => row.record_id === (task.payload as PostTurnPayload).admitted_source_root_id)!;
  expect(projection.source_representation).toEqual({ kind: "canonical_projection", source_record_ids: raw.map(row => row.record_id) });
  expect(projection.source_body).toBe(buildOfficialApiSourceCorpus("", messages.map(message => ({
    role: message.role as "user" | "assistant", content: message.content_excerpt
  }))));
  expect(projection.source_body).not.toContain("\r\n");
  expect(projection.speaker).toBeNull();
  expect((await reportUsage(harness.handler, { turn_index: 41, last_messages: messages })).ok).toBe(true);
  expect(new SqliteFieldSourceRecordRepo(harness.database, fieldContractSha256).listByWorkspace("workspace-1")).toEqual(records);
});
