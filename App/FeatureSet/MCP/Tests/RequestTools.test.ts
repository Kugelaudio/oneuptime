import { McpToolInfo } from "../Types/McpTypes";
import {
  generateRequestTools,
  isRequestTool,
  handleRequestTool,
} from "../Tools/RequestTools";
import OneUptimeApiService from "../Services/OneUptimeApiService";
import { JSONObject } from "Common/Types/JSON";

const TRACE: string = "a".repeat(32);
const OTHER: string = "b".repeat(32);
const TIME: string = "2026-09-08T12:00:00Z";
const WINDOW: { since: string; until: string } = {
  since: "1h",
  until: "2026-09-08T12:30:00Z",
};
function span(spanId: string, extra: JSONObject = {}): JSONObject {
  return {
    spanId,
    traceId: TRACE,
    name: "operation",
    startTime: TIME,
    durationUnixNano: 1000000,
    attributes: {},
    ...extra,
  };
}
function page(rows: JSONObject[]): JSONObject {
  return { data: rows, hasMore: false };
}
function readResult(result: string): Record<string, any> {
  return JSON.parse(result).data;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it("exposes read-only tools and rejects ignored filters", async () => {
  expect(
    generateRequestTools().every((tool: McpToolInfo) => {
      return tool.annotations?.readOnlyHint;
    }),
  ).toBe(true);
  expect(isRequestTool("get_trace")).toBe(true);
  expect(isRequestTool("delete_span")).toBe(false);
  await expect(
    handleRequestTool("search_requests", { organizationId: "1" }, "key"),
  ).rejects.toThrow("Unknown arguments");
});

it("finds organization-bearing descendants then includes an untagged HTTP parent once", async () => {
  const parent: JSONObject = span("http", {
    kind: "SPAN_KIND_SERVER",
    attributes: {
      "http.method": "POST",
      "http.route": "/v1/tts",
      "http.status_code": "200",
    },
  });
  const turn: JSONObject = span("turn", {
    parentSpanId: "http",
    name: "tts.turn",
    attributes: {
      "organization.id": "1",
      "kugelaudio.tts.transport": "http",
      "kugelaudio.tts.outcome": "success",
    },
  });
  const unrelated: JSONObject = span("other", {
    traceId: OTHER,
    kind: "SPAN_KIND_SERVER",
    attributes: { "organization.id": "2", "http.method": "POST" },
  });
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValueOnce(page([turn]))
    .mockResolvedValueOnce(page([parent, turn, unrelated]));
  const result: Record<string, any> = readResult(
    await handleRequestTool(
      "search_requests",
      { ...WINDOW, organization: "1" },
      "key",
    ),
  );
  expect(result["requests"]).toHaveLength(1);
  expect(result["requests"][0]).toMatchObject({
    spanId: "http",
    organizationId: "1",
    kind: "http",
    observedSpanCount: 2,
  });
  expect(spy.mock.calls[0]![0].body).toMatchObject({
    query: {
      attributes: { "organization.id": { _type: "EqualTo", value: "1" } },
    },
  });
  expect(spy.mock.calls[1]![0].body!["query"]).not.toHaveProperty("attributes");
});

it("keeps WS generations distinct from connections and excludes billing-only traces", async () => {
  const first: JSONObject = span("turn1", {
    name: "tts.turn",
    attributes: {
      "connection.id": "socket",
      "generation.id": "gen1",
      "kugelaudio.tts.transport": "websocket_multi",
      "kugelaudio.tts.outcome": "error",
    },
  });
  const second: JSONObject = span("turn2", {
    traceId: OTHER,
    name: "tts.turn",
    attributes: {
      "connection.id": "socket",
      "generation.id": "gen2",
      "kugelaudio.tts.transport": "websocket_multi",
      "kugelaudio.tts.outcome": "success",
    },
  });
  const billing: JSONObject = span("bill", {
    traceId: "c".repeat(32),
    name: "billing.charge",
  });
  const connection: JSONObject = span("socket", {
    traceId: "d".repeat(32),
    kind: "SPAN_KIND_SERVER",
    attributes: { "http.method": "GET", "asgi.scope.type": "websocket" },
  });
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([first, second, billing, connection]));
  const result: Record<string, any> = readResult(
    await handleRequestTool("search_requests", WINDOW, "key"),
  );
  expect(result["requests"]).toHaveLength(2);
  expect(
    result["requests"].map((row: any) => {
      return row.generationId;
    }),
  ).toEqual(["gen1", "gen2"]);
  expect(
    result["requests"].every((row: any) => {
      return row.connectionId === "socket";
    }),
  ).toBe(true);
  const errors: Record<string, any> = readResult(
    await handleRequestTool(
      "search_requests",
      { ...WINDOW, status: "error" },
      "key",
    ),
  );
  expect(errors["requests"]).toHaveLength(1);
  expect(errors["requests"][0].generationId).toBe("gen1");
});

it("does not attribute a mixed-organization request to either tenant", async () => {
  const parent: JSONObject = span("root", {
    kind: "SPAN_KIND_SERVER",
    attributes: { "http.method": "POST" },
  });
  const first: JSONObject = span("a", {
    parentSpanId: "root",
    attributes: { "organization.id": "1" },
  });
  const second: JSONObject = span("b", {
    parentSpanId: "root",
    attributes: { "organization.id": "2" },
  });
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValueOnce(page([first]))
    .mockResolvedValueOnce(page([parent, first, second]));
  const result: Record<string, any> = readResult(
    await handleRequestTool(
      "search_requests",
      { ...WINDOW, organization: "1" },
      "key",
    ),
  );
  expect(result["requests"]).toEqual([]);
  expect(result["coverage"].state).toBe("insufficient_data");
});

it("retrieves untagged spans and logs, reports missing parents and highlights failures", async () => {
  const parent: JSONObject = span("root", {
    parentSpanId: "missing",
    statusCode: 2,
    statusMessage: "timeout",
  });
  const child: JSONObject = span("child", {
    parentSpanId: "root",
    durationUnixNano: 9000000,
  });
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockImplementation(
      async (
        request: Parameters<
          typeof OneUptimeApiService.makeAuthenticatedApiCall
        >[0],
      ) => {
        return request.path.includes("/logs/")
          ? page([{ traceId: TRACE, spanId: "child", body: "failed" }])
          : page([parent, child]);
      },
    );
  const result: Record<string, any> = readResult(
    await handleRequestTool("get_trace", { ...WINDOW, traceId: TRACE }, "key"),
  );
  expect(result["spans"]).toHaveLength(2);
  expect(result["spans"][1].depth).toBe(1);
  expect(result["logs"]).toHaveLength(1);
  expect(result["failures"][0].spanId).toBe("root");
  expect(result["slowestSpans"][0].spanId).toBe("child");
  expect(result["coverage"]).toMatchObject({
    state: "partial",
    missingParentSpanIds: ["missing"],
  });
  expect(
    spy.mock.calls.every(
      ([request]: Parameters<
        typeof OneUptimeApiService.makeAuthenticatedApiCall
      >) => {
        return (
          request.body!["query"] &&
          !Object.keys(request.body!["query"]).includes("attributes")
        );
      },
    ),
  ).toBe(true);
});

it("does not count downstream HTTP server spans as another customer request", async () => {
  const parent: JSONObject = span("http", {
    kind: "SPAN_KIND_SERVER",
    attributes: { "http.method": "POST", "http.route": "/v1/tts" },
  });
  const client: JSONObject = span("client", {
    parentSpanId: "http",
    kind: "SPAN_KIND_CLIENT",
  });
  const downstream: JSONObject = span("normalizer", {
    parentSpanId: "client",
    kind: "SPAN_KIND_SERVER",
    attributes: { "http.method": "POST", "http.route": "/v1/normalize" },
  });
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([parent, client, downstream]));
  const result: Record<string, any> = readResult(
    await handleRequestTool("search_requests", WINDOW, "key"),
  );
  expect(result["requests"]).toHaveLength(1);
  expect(result["requests"][0].endpoint).toBe("/v1/tts");
});

it("rejects organization names before querying", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest.spyOn(OneUptimeApiService, "makeAuthenticatedApiCall");
  await expect(
    handleRequestTool("search_requests", { organization: "Acme" }, "key"),
  ).rejects.toThrow("positive numeric ID");
  expect(spy).not.toHaveBeenCalled();
});

it("owns downstream HTTP calls within one WebSocket generation without inheriting their endpoint", async () => {
  const turn: JSONObject = span("turn", {
    name: "tts.turn",
    attributes: {
      "generation.id": "generation",
      "kugelaudio.tts.transport": "websocket_multi",
    },
  });
  const client: JSONObject = span("client", {
    parentSpanId: "turn",
    kind: "SPAN_KIND_CLIENT",
  });
  const downstream: JSONObject = span("normalizer", {
    parentSpanId: "client",
    kind: "SPAN_KIND_SERVER",
    attributes: { "http.method": "POST", "http.route": "/v1/normalize" },
  });
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([turn, client, downstream]));
  const result: Record<string, any> = readResult(
    await handleRequestTool("search_requests", WINDOW, "key"),
  );
  expect(result["requests"]).toHaveLength(1);
  expect(result["requests"][0]).toMatchObject({
    kind: "generation",
    generationId: "generation",
    endpoint: null,
    observedSpanCount: 3,
  });
});

it.each([9000000, "9000000"])(
  "reads serialized LongNumber duration %s",
  async (value: string | number) => {
    const turn: JSONObject = span("turn", {
      name: "tts.turn",
      durationUnixNano: { _type: "LongNumber", value },
    });
    jest
      .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
      .mockResolvedValue(page([turn]));
    const result: Record<string, any> = readResult(
      await handleRequestTool("search_requests", WINDOW, "key"),
    );
    expect(result["requests"][0].durationMs).toBe(9);
  },
);

it("rejects malformed duration instead of reporting it missing", async () => {
  const turn: JSONObject = span("turn", {
    name: "tts.turn",
    durationUnixNano: { _type: "LongNumber", value: "invalid" },
  });
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([turn]));
  await expect(
    handleRequestTool("search_requests", WINDOW, "key"),
  ).rejects.toThrow("duration");
});

it("rejects a non-string request status before querying", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([]));
  await expect(
    handleRequestTool(
      "search_requests",
      { ...WINDOW, status: ["error"] },
      "key",
    ),
  ).rejects.toThrow("status");
  expect(spy).not.toHaveBeenCalled();
});

it("normalizes uppercase trace IDs for case-sensitive telemetry lookup", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page([]));
  const result: Record<string, any> = readResult(
    await handleRequestTool(
      "get_trace",
      { ...WINDOW, traceId: TRACE.toUpperCase() },
      "key",
    ),
  );
  expect(result["traceId"]).toBe(TRACE);
  expect(
    spy.mock.calls.every(
      ([request]: Parameters<
        typeof OneUptimeApiService.makeAuthenticatedApiCall
      >) => {
        return (request.body!["query"] as JSONObject)["traceId"] === TRACE;
      },
    ),
  ).toBe(true);
});

it("continues request pages with a fixed time window and disjoint request IDs", async () => {
  const rows: JSONObject[] = [
    span("one", { name: "tts.turn" }),
    span("two", { traceId: OTHER, name: "tts.turn" }),
    span("three", { traceId: "c".repeat(32), name: "tts.turn" }),
  ];
  jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue(page(rows));
  const first: Record<string, any> = readResult(
    await handleRequestTool("search_requests", { ...WINDOW, limit: 1 }, "key"),
  );
  expect(first["next"]).toMatchObject({
    tool: "search_requests",
    arguments: {
      since: "2026-09-08T11:30:00.000Z",
      until: "2026-09-08T12:30:00.000Z",
      skip: 1,
      limit: 1,
    },
  });
  const second: Record<string, any> = readResult(
    await handleRequestTool(first["next"].tool, first["next"].arguments, "key"),
  );
  expect(first["requests"][0].requestId).not.toBe(
    second["requests"][0].requestId,
  );
  expect(second["next"].arguments.skip).toBe(2);
  const last: Record<string, any> = readResult(
    await handleRequestTool(
      second["next"].tool,
      second["next"].arguments,
      "key",
    ),
  );
  expect(last["next"]).toBeNull();
  await expect(
    handleRequestTool("search_requests", { ...WINDOW, skip: 1001 }, "key"),
  ).rejects.toThrow("skip");
});
