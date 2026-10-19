import { describe, expect, it } from "vitest";
import { createRegistryHarness, validTimestamp } from "./extension-registry-service-test-fixtures.js";

const skillPackage = {
  skill_id: "skill.filesystem",
  name: "Filesystem Skill Package",
  version: "1.0.0",
  source: "skill_package" as const,
  tool_ids: ["mcp__filesystem__read_file"],
  registered_at: validTimestamp
};

describe("ExtensionRegistryService skill package transaction", () => {
  it("commits the skill package with its registration event before notification", async () => {
    const f = createRegistryHarness();
    let observed: unknown;
    f.notifyEntry.mockImplementationOnce(async () => {
      observed = {
        inTransaction: f.database.connection.inTransaction,
        descriptor: f.database.connection.prepare("SELECT name FROM extension_descriptors WHERE descriptor_id = ?")
          .get(skillPackage.skill_id)
      };
    });
    await expect(f.service.registerSkillPackage(skillPackage)).resolves.toEqual(skillPackage);
    expect(observed).toEqual({ inTransaction: false, descriptor: { name: skillPackage.name } });
    const { events } = await f.eventLogRepo.queryByType("extension.descriptor_registered");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload_json).toMatchObject({ descriptor_type: "skill_package", descriptor_id: skillPackage.skill_id });
    expect(f.notifyEntry).toHaveBeenCalledWith(events[0]);
  });

  it("rolls back the registration event when SQLite rejects skill package persistence", async () => {
    const f = createRegistryHarness();
    f.database.connection.exec(`
      CREATE TEMP TRIGGER refuse_skill BEFORE INSERT ON extension_descriptors
      WHEN NEW.descriptor_type = 'skill_package'
      BEGIN SELECT RAISE(ABORT, 'skill refused'); END;
    `);
    await expect(f.service.registerSkillPackage(skillPackage)).rejects.toThrow("Failed to persist extension descriptor");
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM extension_descriptors").get()).toEqual({ n: 0 });
    expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toEqual({ n: 0 });
    expect(f.notifyEntry).not.toHaveBeenCalled();
  });
});
