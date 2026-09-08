import {
  investigateService,
  compareRelease,
  queryMetrics,
  searchLogs,
} from "../Services/ServiceInvestigation";
import OneUptimeApiService from "../Services/OneUptimeApiService";
import { readTelemetry, TimeWindow } from "../Services/InvestigationQuery";
jest.mock("../Services/OneUptimeApiService");
jest.mock("../Services/InvestigationQuery", () => {
  return {
    ...jest.requireActual("../Services/InvestigationQuery"),
    readTelemetry: jest.fn(),
  };
});
interface AggregateWindow {
  startTimestamp: { value: string };
  endTimestamp: { value: string };
}
const call: jest.Mock =
  OneUptimeApiService.makeAuthenticatedApiCall as jest.Mock;
const read: jest.Mock = readTelemetry as jest.Mock;
const args: Record<string, unknown> = {
  service: "tts",
  environment: "production",
  cluster: "eu",
  since: "30m",
};
beforeEach(() => {
  jest.clearAllMocks();
  read.mockResolvedValue({ rows: [], truncated: false });
  call.mockImplementation(
    async (request: {
      body: {
        aggregateBy: {
          aggregationType: string;
          query: { statusCode?: unknown };
        };
      };
    }) => {
      const agg: { aggregationType: string; query: { statusCode?: unknown } } =
        request.body.aggregateBy;
      return {
        data: [
          {
            value:
              agg.aggregationType === "P95"
                ? 100000000
                : agg.query.statusCode
                  ? 2
                  : 100,
          },
        ],
        truncated: false,
      };
    },
  );
});
it("aggregates the full window, converts nanoseconds, and scopes every query", async () => {
  const result: Record<string, unknown> = await investigateService(
    args,
    "viewer",
  );
  expect(result["statistics"]).toMatchObject({
    operations: 100,
    errors: 2,
    errorRatePercent: 2,
    p95DurationMs: 100,
  });
  for (const [request] of call.mock.calls) {
    expect(request.apiKey).toBe("viewer");
    expect(request.body.aggregateBy.timeoutOverflowMode).toBe("throw");
    expect(request.body.aggregateBy.query.kind).toBe("SPAN_KIND_SERVER");
  }
});
it("does not call zero telemetry healthy", async () => {
  call.mockResolvedValue({ data: [] });
  expect((await investigateService(args, "viewer"))["assessment"]).toBe(
    "insufficient_data",
  );
});
it("does not turn backend failure or truncated totals into a clean bill of health", async () => {
  call.mockRejectedValue(new Error("backend unavailable"));
  await expect(investigateService(args, "viewer")).rejects.toThrow(
    "backend unavailable",
  );
  call.mockResolvedValue({ data: [{ value: 100 }], truncated: true });
  expect((await investigateService(args, "viewer"))["assessment"]).toBe(
    "insufficient_data",
  );
});
it("requires a deployment event and does not infer one from telemetry", async () => {
  const result: Record<string, unknown> = await compareRelease(args, "viewer");
  expect(result["assessment"]).toBe("insufficient_data");
  expect(result["reason"]).toMatch(/deployment event/);
  expect(call).not.toHaveBeenCalled();
});
it("deduplicates delivered events and compares equal mature windows", async () => {
  const time: string = new Date(Date.now() - 60 * 60000).toISOString();
  const event: Record<string, unknown> = {
    time,
    eventType: "deployment",
    attributes: { version: "v2", "deployment.event_id": "event-1" },
  };
  read.mockResolvedValue({ rows: [event, event], truncated: false });
  const result: Record<string, unknown> = await compareRelease(
    { ...args, since: "2h", windowMinutes: 15 },
    "viewer",
  );
  expect(result["assessment"]).toBe("comparison_available");
  expect(result["deployment"]).toMatchObject({ version: "v2" });
  expect(result).toMatchObject({
    baseline: { operations: 100 },
    after: { operations: 100 },
  });
  const windows: AggregateWindow[] = call.mock.calls.map((entry: unknown[]) => {
    const request: { body: { aggregateBy: AggregateWindow } } = entry[0] as {
      body: { aggregateBy: AggregateWindow };
    };
    return request.body.aggregateBy;
  });
  expect(
    windows.every((w: AggregateWindow) => {
      return (
        Date.parse(w.endTimestamp.value) -
          Date.parse(w.startTimestamp.value) ===
        15 * 60000
      );
    }),
  ).toBe(true);
});
it("reports immature and overlapping rollout windows", async () => {
  read.mockResolvedValue({
    rows: [{ time: new Date().toISOString(), attributes: { version: "v2" } }],
    truncated: false,
  });
  expect((await compareRelease(args, "viewer"))["reason"]).toMatch(/mature/);
  expect(call).not.toHaveBeenCalled();
});
it("validates metric functions and never returns non-finite values as valid data", async () => {
  await expect(
    queryMetrics(
      { ...args, metric: "latency", aggregation: "arbitrary-sql" },
      "viewer",
    ),
  ).rejects.toThrow(/aggregation/);
  call.mockResolvedValue({ data: [{ value: "NaN" }] });
  await expect(
    queryMetrics({ ...args, metric: "latency" }, "viewer"),
  ).rejects.toThrow(/aggregate/);
});

it("scopes release history to completed markers and includes the baseline history", async () => {
  await compareRelease({ ...args, since: "2h", windowMinutes: 15 }, "viewer");
  const query: {
    attributes: Record<string, unknown>;
    time: { startValue: string; endValue: string };
  } = read.mock.calls[0]![2];
  expect(query.attributes["deployment.status"]).toEqual({
    _type: "EqualTo",
    value: "completed",
  });
  expect(query.attributes["deployment.scope"]).toEqual({
    _type: "EqualTo",
    value: "speech-stack",
  });
  expect(
    Date.parse(query.time.endValue) - Date.parse(query.time.startValue),
  ).toBe(135 * 60000);
});
it("rejects overlapping redeployments even when the image version is unchanged", async () => {
  const deployed: number = Date.now() - 60 * 60000;
  read.mockResolvedValue({
    rows: [
      {
        time: new Date(deployed).toISOString(),
        attributes: { version: "v2", "deployment.event_id": "new" },
      },
      {
        time: new Date(deployed - 60000).toISOString(),
        attributes: { version: "v2", "deployment.event_id": "previous-config" },
      },
    ],
    truncated: false,
  });
  const result: Record<string, unknown> = await compareRelease(
    { ...args, since: "2h", windowMinutes: 15 },
    "viewer",
  );
  expect(result["reason"]).toMatch(/overlaps/);
  expect(call).not.toHaveBeenCalled();
});

it("continues log searches with a fixed time window and the returned offset", async () => {
  read.mockResolvedValueOnce({
    rows: [
      { time: "2026-09-08T11:59:00Z", body: "first", severityText: "Error" },
      { time: "2026-09-08T11:58:00Z", body: "second", severityText: "Error" },
    ],
    truncated: true,
  });
  const first: Record<string, unknown> = await searchLogs(
    {
      ...args,
      since: "30m",
      limit: 2,
      skip: 5,
      text: "timeout",
      severity: "error",
    },
    "viewer",
  );
  const next: { tool: string; arguments: Record<string, unknown> } = first[
    "next"
  ] as { tool: string; arguments: Record<string, unknown> };
  expect(next.tool).toBe("search_logs");
  expect(next.arguments).toMatchObject({
    service: "tts",
    environment: "production",
    cluster: "eu",
    limit: 2,
    skip: 7,
    text: "timeout",
    severity: "error",
  });
  const window: TimeWindow = first["scope"] as TimeWindow;
  expect(next.arguments["since"]).toBe(window.since);
  expect(next.arguments["until"]).toBe(window.until);
  expect(Date.parse(window.until) - Date.parse(window.since)).toBe(30 * 60000);
  expect(window.since).not.toBe("30m");

  read.mockResolvedValueOnce({
    rows: [{ time: "2026-09-08T11:57:00Z", body: "last" }],
    truncated: false,
  });
  const second: Record<string, unknown> = await searchLogs(
    next.arguments,
    "viewer",
  );
  expect(read.mock.calls[1]?.[0]).toBe("viewer");
  expect(read.mock.calls[1]?.[1]).toBe("logs");
  expect(read.mock.calls[1]?.[2]).toEqual(read.mock.calls[0]?.[2]);
  expect(read.mock.calls[1]?.[4]).toEqual({
    maxRows: 2,
    skip: 7,
    sort: { time: "DESC" },
  });
  expect(second["truncated"]).toBe(false);
  expect(second["next"]).toBeNull();
});

it("filters numeric organization IDs directly in the telemetry query", async () => {
  await investigateService({ ...args, organization: "13" }, "key");
  for (const [request] of call.mock.calls) {
    expect(
      request.body.aggregateBy.query.attributes["organization.id"],
    ).toEqual({ _type: "EqualTo", value: "13" });
  }
  expect(read.mock.calls[0]![2]["attributes"]["organization.id"]).toEqual({
    _type: "EqualTo",
    value: "13",
  });
});

it("rejects organization names before service or release telemetry lookups", async () => {
  await expect(
    investigateService({ ...args, organization: "Acme" }, "key"),
  ).rejects.toThrow("positive numeric ID");
  await expect(
    compareRelease({ ...args, organization: "Acme" }, "key"),
  ).rejects.toThrow("positive numeric ID");
  expect(call).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
