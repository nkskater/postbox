import { describe, expect, it } from "vitest";
import { matchMock, type MockCandidate } from "@/core/mocks/matcher";
const item = (patch: Partial<MockCandidate> = {}): MockCandidate => ({
  id: "first",
  method: "POST",
  path: "/users/:id",
  query: [["page", "1"]],
  body: '{"a":1,"b":2}',
  status: 200,
  name: "Success",
  ...patch,
});
const observed = {
  method: "POST",
  path: "/users/42",
  query: [["page", "1"]] as [string, string][],
  body: '{"b":2,"a":1}',
};
describe("mock request matching", () => {
  it("matches JSON structurally and prefers exact paths independently of candidate order", () => {
    const parameter = item(),
      exact = item({ id: "exact", path: "/users/42" });
    expect(matchMock([parameter, exact], observed)).toBe(exact);
    expect(matchMock([exact, parameter], observed)).toBe(exact);
  });
  it("retains saved order for ties and honors explicit example choices", () => {
    const first = item(),
      second = item({ id: "second", status: 404, name: "Missing" });
    expect(matchMock([first, second], observed)).toBe(first);
    expect(matchMock([first, second], observed, { exampleId: "second" })).toBe(second);
    expect(matchMock([first, second], observed, { status: 404, exampleName: "Missing" })).toBe(second);
    expect(matchMock([first], observed, { exampleId: "missing" })).toBeNull();
  });
  it("preserves duplicate query values and rejects method/body/query mismatches", () => {
    const candidate = item();
    for (const patch of [
      { method: "GET" },
      { body: "different" },
      {
        query: [
          ["page", "1"],
          ["page", "1"],
        ] as [string, string][],
      },
    ])
      expect(matchMock([candidate], { ...observed, ...patch })).toBeNull();
    expect(
      matchMock(
        [candidate],
        { ...observed, body: "different", query: [] },
        { matchBody: false, matchQuery: false },
      ),
    ).toBe(candidate);
  });
  it("decodes segments without treating encoded slashes as parameter boundaries", () => {
    expect(
      matchMock([item({ path: "/users/{{id}}" })], { ...observed, path: "/users/caf%C3%A9" }),
    ).not.toBeNull();
    expect(matchMock([item()], { ...observed, path: "/users/a%2Fb" })).toBeNull();
    expect(() => matchMock([item()], { ...observed, path: "/users/%ZZ" })).toThrow(URIError);
  });
});
