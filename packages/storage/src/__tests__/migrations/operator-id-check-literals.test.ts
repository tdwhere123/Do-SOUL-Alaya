import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

describe("formation operator_id CHECK literals", () => {
  it("embeds the protocol operator_id constants in migration SQL", () => {
    const opsAndControl = fs.readFileSync(
      path.join(migrationsDirectory, "002-ops-and-control.sql"),
      "utf8"
    );
    const memoryFtsAndGarden = fs.readFileSync(
      path.join(migrationsDirectory, "003-memory-fts-and-garden.sql"),
      "utf8"
    );
    expect(opsAndControl).toContain(EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID);
    expect(memoryFtsAndGarden).toContain(OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID);
  });
});
