import Log from "Common/Models/AnalyticsModels/Log";
import Span from "Common/Models/AnalyticsModels/Span";
import Metric from "Common/Models/AnalyticsModels/Metric";
import ChangeEvent from "Common/Models/AnalyticsModels/ChangeEvent";
import AnalyticsBaseModel from "Common/Models/AnalyticsModels/AnalyticsBaseModel/AnalyticsBaseModel";
import StatementGenerator from "Common/Server/Utils/AnalyticsDatabase/StatementGenerator";
import { ClickhouseAppInstance } from "Common/Server/Infrastructure/ClickhouseDatabase";
import SortOrder from "Common/Types/BaseDatabase/SortOrder";
import JSONFunctions from "Common/Types/JSONFunctions";
import { JSONObject } from "Common/Types/JSON";
import InBetween from "Common/Types/BaseDatabase/InBetween";
import TableColumnType from "Common/Types/AnalyticsDatabase/TableColumnType";
import { Statement } from "Common/Server/Utils/AnalyticsDatabase/Statement";
import {
  TimeWindow,
  parseTimeWindow,
  telemetryQuery,
  readTelemetry,
  scalar,
} from "../Services/InvestigationQuery";
import OneUptimeApiService from "../Services/OneUptimeApiService";

afterEach(() => {
  jest.restoreAllMocks();
});

it("resolves bounded relative and explicit UTC windows", () => {
  expect(
    parseTimeWindow({ since: "30m" }, new Date("2026-09-08T12:00:00Z")),
  ).toEqual({
    since: "2026-09-08T11:30:00.000Z",
    until: "2026-09-08T12:00:00.000Z",
  });
  expect(() => {
    parseTimeWindow({ since: "8d" });
  }).toThrow("7 days");
  expect(() => {
    parseTimeWindow({ since: "0m" });
  }).toThrow();
  expect(() => {
    parseTimeWindow({ since: "yesterday" });
  }).toThrow();
  expect(() => {
    parseTimeWindow({ until: 12 });
  }).toThrow();
});

it("uses exact attribute filters and format-specific environment keys", () => {
  const window: TimeWindow = parseTimeWindow({ since: "1h" });
  expect(
    telemetryQuery(
      { service: "tts", environment: "production", project: "4" },
      window,
      "startTime",
    ),
  ).toMatchObject({
    attributes: {
      "oneuptime.service.name": {
        _type: "Includes",
        value: ["tts", "kugelaudio-tts", "tts-tts-kugel-3"],
      },
      "resource.deployment.environment.name": { value: "production" },
      "project.id": { value: "4" },
    },
  });
  expect(
    telemetryQuery({ environment: "production" }, window, "time"),
  ).toMatchObject({
    attributes: {
      "resource.oneuptime.label.environment": { value: "production" },
    },
  });
  expect(scalar({ _type: "DateTime", value: "date" })).toBe("date");
});

it("advances offsets using actual page sizes and follows hasMore", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValueOnce({
      data: [{ spanId: "a" }, { spanId: "b" }],
      hasMore: true,
    })
    .mockResolvedValueOnce({ data: [{ spanId: "c" }], hasMore: false });
  const result: Awaited<ReturnType<typeof readTelemetry>> = await readTelemetry(
    "key",
    "span",
    {},
    ["spanId"],
  );
  expect(result).toEqual({
    rows: [{ spanId: "a" }, { spanId: "b" }, { spanId: "c" }],
    truncated: false,
  });
  expect(spy.mock.calls[1]![0].path).toBe(
    "/api/span/get-list?skip=2&limit=250",
  );
});

it("marks bounds and rejects broken pagination or malformed pages", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValue({ data: [{ spanId: "a" }], hasMore: true });
  expect(
    (await readTelemetry("key", "span", {}, [], { maxRows: 1 })).truncated,
  ).toBe(true);
  await expect(readTelemetry("key", "span", {}, [])).rejects.toThrow(
    "did not advance",
  );
  spy.mockResolvedValue({ error: "denied" });
  await expect(readTelemetry("key", "span", {}, [])).rejects.toThrow(
    "Malformed",
  );
  spy.mockRejectedValue(new Error("403"));
  await expect(readTelemetry("key", "span", {}, [])).rejects.toThrow("403");
});

it("survives the actual API deserializer and ClickHouse timestamp binder", () => {
  const window: TimeWindow = parseTimeWindow({
    since: "30m",
    until: "2026-09-08T12:00:00Z",
  });
  const query: JSONObject = JSONFunctions.deserialize(
    telemetryQuery({}, window, "startTime") as JSONObject,
  );
  const bound: InBetween<string> = query[
    "startTime"
  ] as unknown as InBetween<string>;
  expect(bound).toBeInstanceOf(InBetween);
  const statement: Statement = new Statement();
  expect(
    statement.serializseValue({
      value: bound.startValue,
      type: TableColumnType.DateTime64,
    }),
  ).toBe("2026-09-08 11:30:00.000000000");
  expect(
    statement.serializseValue({
      value: bound.endValue,
      type: TableColumnType.DateTime64,
    }),
  ).toBe("2026-09-08 12:00:00.000000000");
});

it("continues log pagination from an explicit offset", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValueOnce({ data: [{ body: "first" }], hasMore: true })
    .mockResolvedValueOnce({ data: [{ body: "second" }], hasMore: false });
  await readTelemetry("key", "logs", {}, ["body"], { skip: 40 });
  expect(spy.mock.calls[0]![0].path).toBe(
    "/api/logs/get-list?skip=40&limit=250",
  );
  expect(spy.mock.calls[1]![0].path).toBe(
    "/api/logs/get-list?skip=41&limit=250",
  );
  await expect(
    readTelemetry("key", "logs", {}, [], { skip: -1 }),
  ).rejects.toThrow("skip");
  await expect(
    readTelemetry("key", "logs", {}, [], { skip: 100001 }),
  ).rejects.toThrow("skip");
});

it("preserves deterministic timestamp and ID ordering on every page", async () => {
  const spy: jest.SpyInstance<
    ReturnType<typeof OneUptimeApiService.makeAuthenticatedApiCall>,
    Parameters<typeof OneUptimeApiService.makeAuthenticatedApiCall>
  > = jest
    .spyOn(OneUptimeApiService, "makeAuthenticatedApiCall")
    .mockResolvedValueOnce({
      data: [{ _id: "a", time: "same" }],
      hasMore: true,
    })
    .mockResolvedValueOnce({
      data: [{ _id: "b", time: "same" }],
      hasMore: false,
    });
  await readTelemetry("key", "logs", {}, ["time"], { sort: { time: "ASC" } });
  expect(
    spy.mock.calls.map(
      ([call]: Parameters<
        typeof OneUptimeApiService.makeAuthenticatedApiCall
      >): unknown => {
        return call.body!["sort"];
      },
    ),
  ).toEqual([
    { time: "ASC", _id: "ASC" },
    { time: "ASC", _id: "ASC" },
  ]);
  spy.mockResolvedValue({ data: [], hasMore: false });
  await readTelemetry("key", "span", {}, ["spanId"]);
  expect(spy.mock.calls[2]![0].body!["sort"]).toEqual({
    startTime: "DESC",
    _id: "ASC",
  });
});

it("accepts the unique ID tie breaker in each telemetry model's actual SQL generator", () => {
  for (const modelType of [Log, Span, Metric, ChangeEvent]) {
    const generator: StatementGenerator<AnalyticsBaseModel> =
      new StatementGenerator<AnalyticsBaseModel>({
        modelType,
        database: ClickhouseAppInstance,
      });
    const column: string = modelType === Span ? "startTime" : "time";
    expect(generator.model.getTableColumn("_id")?.type).toBe(
      TableColumnType.ObjectID,
    );
    const statement: Statement = generator.toSortStatement({
      [column]: SortOrder.Descending,
      _id: SortOrder.Ascending,
    });
    expect(statement.query).toBe("{p0:Identifier} DESC, {p1:Identifier} ASC");
    expect(statement.query_params).toEqual({ p0: column, p1: "_id" });
  }
});
