import { expect, it } from "vitest";
import { sourceIndexTarget, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { renderMemberIndex } from "../../../runtime/recall-read-worker/member-index.js";

const member = (root: string) => sourceIndexTarget(sourceRecallTarget({ workspace_id: "workspace-render", root_kind: "source_record",
  root_id: root, source_version: "v1", content_digest: `sha256:${"0".repeat(64)}`, evidence_object_id: null }), "source", 16);
const resources = { work: 1, memory_bytes: 1, native_bytes: 0, sql_internal_work: "unknown" as const };
const ready = (text: string) => ({ status: "ready" as const, statements: [], event_time: null, first_message: text, resources });

it("omits an unknown member but ends the list at the first budget refusal", () => {
  const listings = new Map<string, unknown>([
    ["root-a", ready("first")],
    ["root-b", { status: "unknown", reason: "source_template_stale:erased", resources }],
    ["root-c", ready("third")],
    ["root-d", { status: "resource_limited", reason: "member_listing_read_budget:payload", resources }],
    ["root-e", ready("never read")]
  ]);
  const read: string[] = [];
  const lines = renderMemberIndex({ readMemberListing: source => {
    const root = source.target.root_id;
    read.push(root);
    return listings.get(root) as ReturnType<Parameters<typeof renderMemberIndex>[0]["readMemberListing"]>;
  } }, { pool: ["root-a", "root-b", "root-c", "root-d", "root-e"].map(member), overflow: [], conditions: [], vectors: null },
  new Set(), 5);
  expect(lines.map(line => [line.label, line.root_id, line.line])).toEqual([["R06", "root-a", "first"], ["R07", "root-c", "third"]]);
  expect(read).toEqual(["root-a", "root-b", "root-c", "root-d"]);
});

it("keeps 32 renderable members after one empty listing", () => {
  const roots = ["empty", ...Array.from({ length: 32 }, (_, index) => `root-${index}`)];
  const lines = renderMemberIndex({ readMemberListing: source => source.target.root_id === "empty"
    ? { status: "ready" as const, statements: [], event_time: null, first_message: null, resources }
    : ready(source.target.root_id) }, { pool: roots.map(member), overflow: [], conditions: [], vectors: null },
  new Set(), 0);
  expect(lines).toHaveLength(32);
  expect(lines[0]?.root_id).toBe("root-0");
  expect(lines[31]?.root_id).toBe("root-31");
});

it("places Soft neighbors after pool members and before overflow", () => {
  const lines = renderMemberIndex({ readMemberListing: source => ready(source.target.root_id) }, {
    pool: ["pool-a"].map(member), neighbors: ["graph-b"].map(member), overflow: ["overflow-c"].map(member),
    conditions: [], vectors: null
  }, new Set(["delivered"]), 1);
  expect(lines.map(line => [line.root_id, line.in_pool])).toEqual([
    ["pool-a", true], ["graph-b", false], ["overflow-c", false]
  ]);
});

it("passes null vectors to readMemberListing when conditions are empty and preserves them when non-empty", () => {
  const vectors = { generation_id: "gen-1", dimensions: 2 };
  const seen: Array<{ generation_id: string; dimensions: number } | null> = [];
  const repo = {
    readMemberListing: (_source: ReturnType<typeof member>, listingVectors: { generation_id: string; dimensions: number } | null) => {
      seen.push(listingVectors);
      return ready("entry");
    }
  };
  renderMemberIndex(repo, { pool: [member("root-0")], overflow: [], conditions: [], vectors }, new Set(), 0);
  renderMemberIndex(repo, {
    pool: [member("root-1")], overflow: [], conditions: [Float32Array.of(1, 0)], vectors
  }, new Set(), 0);
  expect(seen).toEqual([null, vectors]);
});
