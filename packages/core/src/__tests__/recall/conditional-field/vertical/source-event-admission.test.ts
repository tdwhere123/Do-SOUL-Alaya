import { afterEach, expect, it } from "vitest";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { encodedRecall, openBoundSlice, runRecall } from "../../conditional-field-oracle/bound-producer.js";
import { WS } from "./source-slice.js";
import { LAST_WEEK_INSTANT, YESTERDAY_INSTANT } from "../reference/deployment.fixture.js";
import { fieldSha256, hashedRecord } from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";
import { sourceFactsSatisfyFilters } from "../../../../recall/conditional-field/query/ordinary-language.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const db of databases) db.close(); databases.clear(); });

it.each([
  ["successful deployment yesterday", "false"],
  ["failed payment yesterday", "unresolved"],
  ["If deployment failed yesterday, roll back", "unresolved"],
  ['The manual mentions "failed deployment" as an example', "unresolved"],
  ["The deployment did not fail yesterday.", "false"],
  ["Alice said deployment failed yesterday.", "unresolved"],
  ["Deployment failed yesterday?", "unresolved"],
  ['"Deployment failed yesterday."', "unresolved"],
  ["Deployment might have failed yesterday.", "unresolved"]
] as const)("does not prove a failed event from %s", async (body, verdict) => {
  const slice = await openBoundSlice((db) => databases.add(db));
  const record = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert({
    ...hashedRecord(WS, body), event_time: YESTERDAY_INSTANT
  });
  const index = runRecall(slice, { query_text: "yesterday failed deployment", result_kind_view: "source_only" });
  const entries = index.entries.filter((entry) => entry.target.kind === "source_evidence" && entry.target.root_id === record.record_id);
  expect(entries).toEqual([]);
  expect(sourceFactsSatisfyFilters({ event_kind: "failed_deployment" }, { content: body })).toBe(verdict);
  if (verdict === "unresolved") {
    expect(index.completeness.logical_index).not.toBe("complete");
  } else {
    expect(index.completeness.logical_index).toBe("complete");
  }
});

it.each(["Deployment failed yesterday.", "yesterday failed deployment of checkout"])(
  "admits an actual event without model formation: %s", async (body) => {
    const slice = await openBoundSlice((db) => databases.add(db));
    const record = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert({
      ...hashedRecord(WS, body), event_time: YESTERDAY_INSTANT
    });
    const index = runRecall(slice, { query_text: "yesterday failed deployment", result_kind_view: "source_only" });
    expect(index.entries.some((entry) => entry.target.kind === "source_evidence" &&
      entry.target.root_id === record.record_id && entry.guaranteed_milligrades === 1000)).toBe(true);
    expect(encodedRecall(index)).toMatchObject({ provider_calls: 0, garden_enqueue: 0 });
    expect(index.completeness.logical_index).toBe("complete");
  }
);

it("does not infer a real event from a conditional memory sentence", () => {
  expect(sourceFactsSatisfyFilters({ event_kind: "failed_deployment" }, {
    content: "If deployment failed, roll back"
  })).toBe("unresolved");
});

it("excludes an out-of-window unresolved event without holding an independent in-window event open", async () => {
  const slice = await openBoundSlice((db) => databases.add(db));
  const repo = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const outside = repo.insert({ ...hashedRecord(WS, "If deployment failed, roll back"), event_time: LAST_WEEK_INSTANT });
  const inside = repo.insert({ ...hashedRecord(WS, "deployment failed"), event_time: YESTERDAY_INSTANT });
  const index = runRecall(slice, { query_text: "yesterday failed deployment", result_kind_view: "source_only" });
  expect(index.entries.some((entry) => entry.target.kind === "source_evidence" && entry.target.root_id === outside.record_id)).toBe(false);
  expect(index.entries.some((entry) => entry.target.kind === "source_evidence" && entry.target.root_id === inside.record_id)).toBe(true);
  expect(index.completeness.logical_index).toBe("complete");
});
