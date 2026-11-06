export const attr = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});
export function span(i = 1, at = Date.now(), duration = 50, status = 200, route = "/api/users/{userId}") {
  return {
    traceId: i.toString(16).padStart(32, "0"),
    spanId: i.toString(16).padStart(16, "0"),
    kind: 2,
    name: "SECRET span name",
    startTimeUnixNano: String(BigInt(Math.floor(at - duration)) * BigInt(1000000)),
    endTimeUnixNano: String(BigInt(at) * BigInt(1000000)),
    attributes: [
      attr("http.request.method", "GET"),
      attr("http.response.status_code", status),
      attr("http.route", route),
      attr("url.full", "https://user:SECRET@example.test/api/users/private-email?token=SECRET"),
      attr("http.request.header.authorization", "SECRET"),
      attr("db.statement", "SECRET"),
    ],
    status: { code: status >= 500 ? 2 : 1, message: "SECRET error" },
    events: [{ name: "SECRET event" }],
  };
}
export const batch = (spans: unknown[], service = "checkout") => ({
  resourceSpans: [
    {
      resource: { attributes: [attr("service.name", service), attr("secret", "SECRET")] },
      scopeSpans: [{ spans }],
    },
  ],
});
