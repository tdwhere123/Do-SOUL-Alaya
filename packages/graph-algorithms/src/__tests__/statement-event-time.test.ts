import { describe, expect, it } from "vitest";
import { statementEventIntervals } from "../index.js";

const session = Date.UTC(2023, 0, 10); // Tuesday
const days = (text: string, at = session) => statementEventIntervals(text, at)
  .map(span => `${new Date(span.startDay).toISOString().slice(0, 10)}..${new Date(span.endDay).toISOString().slice(0, 10)}`);

describe("statement event days", () => {
  it("reads year-less dates and bare weekdays as their latest occurrence on or before the session", () => {
    expect(days("I bought it on January 5th.")).toEqual(["2023-01-05..2023-01-05"]);
    expect(days("We met on December 25th.")).toEqual(["2022-12-25..2022-12-25"]);
    expect(days("the 3rd of January")).toEqual(["2023-01-03..2023-01-03"]);
    expect(days("set up on 1/8")).toEqual(["2023-01-08..2023-01-08"]);
    expect(days("我在1月8日买的")).toEqual(["2023-01-08..2023-01-08"]);
    expect(days("I ran on Saturday")).toEqual(["2023-01-07..2023-01-07"]);
    expect(days("我周日去了")).toEqual(["2023-01-08..2023-01-08"]);
  });

  it("resolves relative terms from the session and keeps dated terms", () => {
    expect(days("I went there yesterday")).toEqual(["2023-01-09..2023-01-09"]);
    expect(days("three weeks ago")).toEqual(["2022-12-19..2022-12-25"]);
    expect(days("三周前")).toEqual(["2022-12-19..2022-12-25"]);
    expect(days("graduated on May 20th, 2017")).toEqual(["2017-01-01..2017-12-31", "2017-05-20..2017-05-20"]);
    expect(days("on 2022-11-03")).toEqual(["2022-11-03..2022-11-03"]);
  });

  it("states no day without a time expression", () => {
    expect(days("I have 12 rare coins and attend classes on Saturdays.")).toEqual([]);
  });

  it("reads a bare numeric pair as month/day: a fallible observation that only routes", () => {
    expect(days("version 3/4 of the plan")).toEqual(["2022-03-04..2022-03-04"]);
  });
});
