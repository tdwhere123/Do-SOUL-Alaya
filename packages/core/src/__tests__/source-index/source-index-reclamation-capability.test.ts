import { expect, it } from "vitest";
import type { SourceIndexRepository } from "@do-soul/alaya-protocol";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { BUDGET, WORKSPACE, buildReady, configuration, fieldSha256, fixture, publishSource } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";

it("reports reclamation unavailable for an otherwise compatible adapter without claiming an empty queue", () => {
  const environment = fixture();
  try {
    publishSource(environment, "retired payload");
    const old = buildReady(environment);
    buildReady(environment, configuration({ model_revision: "replacement" }));
    const alternate = new Proxy(environment.index, { get(target, key) {
      return key === "reclaimVectorPage" ? undefined : Reflect.get(target, key, target);
    } });
    // An adapter implementing the original port still satisfies the updated interface.
    const originalPort: Omit<SourceIndexRepository, "reclaimVectorPage"> = alternate;
    const compatible: SourceIndexRepository = originalPort;
    const lifecycle = new SourceIndexLifecycle(compatible, fieldSha256);
    expect(lifecycle.reclaimVectorPage(WORKSPACE, 2, BUDGET)).toEqual({ status: "unavailable",
      reason: "vector_reclamation_not_supported", resources: { work: 0, native_bytes: 0 } });
    expect(environment.index.generation(WORKSPACE, old.generation.generation_id)?.status).toBe("retired");
    expect(environment.database.connection.prepare("SELECT count(*) AS n FROM source_index_vectors WHERE generation_id=?")
      .get(old.generation.generation_id)).toEqual({ n: 2 });
  } finally { environment.database.close({ optimize: false }); }
});
