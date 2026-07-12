import { describe, expect, it } from "vitest";
import { deriveFacetsFromText } from "../../shared/facet-keywords.js";

describe("deriveFacetsFromText relationship concepts", () => {
  it("aligns personal relationship facets without non-personal partner pollution", () => {
    expect(deriveFacetsFromText("My cousin and sibling attended."))
      .toContain("relationship_person");
    expect(deriveFacetsFromText("Acme is a business partner."))
      .not.toContain("relationship_person");
    expect(deriveFacetsFromText("Contoso is a technology partner."))
      .not.toContain("relationship_person");
  });

  it("mirrors CJK query facets on the write side", () => {
    expect(deriveFacetsFromText("我的工作地点和健康情况")).toEqual(
      expect.arrayContaining(["occupation_work", "location_place", "health"])
    );
    expect(deriveFacetsFromText("我什么时候去旅行")).toEqual(
      expect.arrayContaining(["time_date", "travel"])
    );
  });

  it.each([
    "我拥有一台相机",
    "她持有两张票",
    "这辆车属于我",
    "这套房归他们所有",
    "我有一只猫",
    "我有车",
    "她有自己的房子",
    "他有三台电脑",
    "我们有猫"
  ])("derives possession only from an explicit CJK possession phrase: %s", (text) => {
    expect(deriveFacetsFromText(text)).toContain("possession_item");
  });

  it.each([
    "所有发布检查项",
    "没有预算安排",
    "有关部署文档",
    "我没有车",
    "我有关部署文档"
  ])("does not derive possession from an incidental CJK 有 substring: %s", (text) => {
    expect(deriveFacetsFromText(text)).not.toContain("possession_item");
  });
});
