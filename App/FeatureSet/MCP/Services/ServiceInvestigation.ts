import { JSONObject } from "Common/Types/JSON";
import OneUptimeApiService from "./OneUptimeApiService";
import {
  parseTimeWindow,
  telemetryQuery,
  readTelemetry,
  scalar,
  TimeWindow,
} from "./InvestigationQuery";
import { resolveOrganization } from "./OrganizationDirectory";

type Args = Record<string, unknown>;
type Row = Record<string, unknown>;
interface AggregateResult {
  rows: Row[];
  truncated: boolean;
}
interface Statistics {
  operations: number;
  errors: number;
  errorRatePercent: number | null;
  p95DurationMs: number | null;
  operationsPerMinute: number;
  truncated: boolean;
}
const SERVER_KIND: string = "SPAN_KIND_SERVER";
const SPAN_ERROR: number = 2;
const AGGREGATIONS: string[] = [
  "Count",
  "Avg",
  "Sum",
  "Min",
  "Max",
  "P50",
  "P90",
  "P95",
  "P99",
];

function required(args: Args, key: string): string {
  const value: unknown = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}
function attributes(row: Row): Row {
  const attrs: unknown = row["attributes"];
  return attrs && typeof attrs === "object" && !Array.isArray(attrs)
    ? (attrs as Row)
    : {};
}
function date(value: string): JSONObject {
  return { _type: "DateTime", value };
}

async function scopedQuery(
  args: Args,
  window: TimeWindow,
  column: string,
  apiKey: string,
): Promise<Row> {
  const query: Row = telemetryQuery(args, window, column);
  const attrs: Row = { ...((query["attributes"] as Row) || {}) };
  if (args["organization"] !== undefined) {
    attrs["organization.id"] = {
      _type: "EqualTo",
      value: await resolveOrganization(required(args, "organization"), apiKey),
    };
  }
  if (args["project"] !== undefined) {
    attrs["project.id"] = {
      _type: "EqualTo",
      value: required(args, "project"),
    };
  }
  query["attributes"] = attrs;
  return query;
}

/** Full-window aggregation; never estimate totals or percentiles from a list page. */
async function aggregate(
  apiKey: string,
  resource: "span" | "metrics",
  query: Row,
  window: TimeWindow,
  type: string,
  options: { interval?: string; groupBy?: Row; attributeKeys?: string[] } = {},
): Promise<AggregateResult> {
  const timestamp: string = resource === "span" ? "startTime" : "time";
  const result: unknown = await OneUptimeApiService.makeAuthenticatedApiCall({
    method: "POST",
    path: `/api/${resource}/aggregate`,
    apiKey,
    body: {
      aggregateBy: {
        query,
        aggregateColumnName: resource === "span" ? "durationUnixNano" : "value",
        aggregationType: type,
        aggregationTimestampColumnName: timestamp,
        aggregationInterval: options.interval || "Total",
        startTimestamp: date(window.since),
        endTimestamp: date(window.until),
        skip: 0,
        limit: 200,
        timeoutOverflowMode: "throw",
        ...(options.groupBy ? { groupBy: options.groupBy } : {}),
        ...(options.attributeKeys
          ? { groupByAttributeKeys: options.attributeKeys }
          : {}),
      },
    } as JSONObject,
  });
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as Row)["data"])
  ) {
    throw new Error("Malformed aggregate response: expected data rows.");
  }
  const envelope: Row = result as Row;
  const rows: Row[] = (envelope["data"] as Row[]).map((row: Row) => {
    const value: unknown = scalar(row["value"]);
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      typeof value === "boolean" ||
      !Number.isFinite(Number(value))
    ) {
      throw new Error("Invalid aggregate value returned by telemetry API.");
    }
    return { ...row, value: Number(value) };
  });
  return {
    rows,
    truncated: envelope["truncated"] === true || rows.length >= 200,
  };
}

async function statistics(
  apiKey: string,
  query: Row,
  window: TimeWindow,
): Promise<Statistics> {
  /*
   * Server operations have a consistent denominator across ingress and downstream
   * services. These are NOT unique customer requests or logical WebSocket turns.
   */
  const scoped: Row = { ...query, kind: SERVER_KIND };
  const [total, errors, latency]: AggregateResult[] = await Promise.all([
    aggregate(apiKey, "span", scoped, window, "Count"),
    aggregate(
      apiKey,
      "span",
      { ...scoped, statusCode: SPAN_ERROR },
      window,
      "Count",
    ),
    aggregate(apiKey, "span", scoped, window, "P95"),
  ]);
  for (const result of [total!, errors!, latency!]) {
    if (result.rows.length > 1) {
      throw new Error(
        "Whole-window aggregate unexpectedly returned multiple rows.",
      );
    }
  }
  const operations: number = Number(total!.rows[0]?.["value"] || 0);
  const errorCount: number = Number(errors!.rows[0]?.["value"] || 0);
  if (operations < 0 || errorCount < 0 || errorCount > operations) {
    throw new Error(
      "Inconsistent operation/error aggregates; retry a fixed completed time window.",
    );
  }
  return {
    operations,
    errors: errorCount,
    errorRatePercent: operations ? (errorCount / operations) * 100 : null,
    p95DurationMs:
      operations && latency!.rows.length
        ? Number(latency!.rows[0]!["value"]) / 1_000_000
        : null,
    operationsPerMinute:
      operations /
      ((Date.parse(window.until) - Date.parse(window.since)) / 60000),
    truncated: total!.truncated || errors!.truncated || latency!.truncated,
  };
}

export async function investigateService(
  args: Args,
  apiKey: string,
): Promise<Row> {
  required(args, "service");
  const window: TimeWindow = parseTimeWindow(args);
  const query: Row = await scopedQuery(args, window, "startTime", apiKey);
  const [stats, groups, sample]: [
    Statistics,
    AggregateResult,
    Awaited<ReturnType<typeof readTelemetry>>,
  ] = await Promise.all([
    statistics(apiKey, query, window),
    aggregate(
      apiKey,
      "span",
      { ...query, kind: SERVER_KIND, statusCode: SPAN_ERROR },
      window,
      "Count",
      { groupBy: { name: true, statusMessage: true } },
    ),
    readTelemetry(
      apiKey,
      "span",
      { ...query, kind: SERVER_KIND, statusCode: SPAN_ERROR },
      [
        "traceId",
        "spanId",
        "name",
        "startTime",
        "statusCode",
        "statusMessage",
        "durationUnixNano",
        "attributes",
      ],
      { maxRows: 10, sort: { startTime: "DESC" } },
    ),
  ]);
  const assessment: string =
    !stats.operations || stats.truncated
      ? "insufficient_data"
      : stats.errors
        ? "errors_observed"
        : "no_errors_observed";
  return {
    success: true,
    operation: "investigate_service",
    scope: { ...args, ...window },
    assessment,
    measurement:
      "Recorded server spans; excludes client/internal spans. Counts are operations, not unique customer requests or WebSocket generations.",
    statistics: stats,
    errorOperations: groups.rows.map((r: Row) => {
      return {
        name: scalar(r["name"]),
        message: scalar(r["statusMessage"]),
        count: r["value"],
      };
    }),
    examples: sample.rows.map((r: Row) => {
      return {
        traceId: scalar(r["traceId"]),
        name: scalar(r["name"]),
        time: scalar(r["startTime"]),
        durationMs: Number(scalar(r["durationUnixNano"])) / 1_000_000,
        message: String(scalar(r["statusMessage"]) || "").slice(0, 1000),
        version: attributes(r)["resource.service.version"],
        cluster: attributes(r)["oneuptime.kubernetes.cluster.name"],
      };
    }),
    coverage: {
      statisticsComplete: !stats.truncated,
      errorGroupsTruncated: groups.truncated,
      examplesTruncated: sample.truncated,
      note: "No recorded errors is not proof of availability; missing instrumentation and collector gaps remain possible. Examples are bounded; statistics aggregate the entire window.",
    },
  };
}

export async function queryMetrics(args: Args, apiKey: string): Promise<Row> {
  const metric: string = required(args, "metric");
  const type: string =
    typeof args["aggregation"] === "string" ? args["aggregation"] : "Avg";
  if (!AGGREGATIONS.includes(type)) {
    throw new Error(`aggregation must be one of ${AGGREGATIONS.join(", ")}.`);
  }
  const window: TimeWindow = parseTimeWindow(args);
  const query: Row = await scopedQuery(args, window, "time", apiKey);
  query["name"] = { _type: "EqualTo", value: metric };
  const interval: string =
    typeof args["interval"] === "string" ? args["interval"] : "FiveMinutes";
  if (
    ![
      "Minute",
      "FiveMinutes",
      "FifteenMinutes",
      "ThirtyMinutes",
      "Hour",
      "Day",
      "Total",
    ].includes(interval)
  ) {
    throw new Error("Invalid metric interval.");
  }
  const keys: unknown = args["groupBy"];
  if (
    keys !== undefined &&
    (!Array.isArray(keys) ||
      keys.length > 3 ||
      keys.some((k: unknown) => {
        return typeof k !== "string" || !k;
      }))
  ) {
    throw new Error("groupBy must contain at most three attribute names.");
  }
  const result: AggregateResult = await aggregate(
    apiKey,
    "metrics",
    query,
    window,
    type,
    { interval, ...(keys ? { attributeKeys: keys as string[] } : {}) },
  );
  return {
    success: true,
    operation: "query_metrics",
    scope: { ...args, ...window },
    aggregation: type,
    interval,
    data: result.rows,
    truncated: result.truncated,
    assessment: result.rows.length ? "data_available" : "insufficient_data",
    note: "Values retain the metric's native unit. An absent metric is not zero. Counts count telemetry points; cumulative counters require rate-aware interpretation.",
  };
}

export async function searchLogs(args: Args, apiKey: string): Promise<Row> {
  const window: TimeWindow = parseTimeWindow(args);
  const query: Row = await scopedQuery(args, window, "time", apiKey);
  if (args["text"] !== undefined) {
    query["body"] = { _type: "Search", value: required(args, "text") };
  }
  if (args["severity"] !== undefined) {
    const severity: string = required(args, "severity").toLowerCase();
    const levels: Record<string, string> = {
      trace: "Trace",
      debug: "Debug",
      info: "Information",
      information: "Information",
      warning: "Warning",
      warn: "Warning",
      error: "Error",
      fatal: "Fatal",
    };
    if (!levels[severity]) {
      throw new Error("Invalid log severity.");
    }
    query["severityText"] = { _type: "EqualTo", value: levels[severity] };
  }
  const limit: number =
    args["limit"] === undefined ? 20 : Number(args["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100.");
  }
  const skip: number = args["skip"] === undefined ? 0 : Number(args["skip"]);
  if (!Number.isInteger(skip) || skip < 0 || skip > 100000) {
    throw new Error("skip must be an integer from 0 to 100000.");
  }
  const result: Awaited<ReturnType<typeof readTelemetry>> = await readTelemetry(
    apiKey,
    "logs",
    query,
    ["_id", "time", "body", "severityText", "traceId", "spanId", "attributes"],
    { maxRows: limit, skip, sort: { time: "DESC" } },
  );
  return {
    success: true,
    operation: "search_logs",
    scope: { ...args, ...window },
    truncated: result.truncated,
    next: result.truncated
      ? {
          tool: "search_logs",
          arguments: {
            ...args,
            since: window.since,
            until: window.until,
            skip: skip + result.rows.length,
          },
        }
      : null,
    data: result.rows.map((row: Row) => {
      const body: string = String(scalar(row["body"]) || "");
      const attrs: Row = attributes(row);
      return {
        id: scalar(row["_id"]),
        time: scalar(row["time"]),
        severity: scalar(row["severityText"]),
        body: body.slice(0, 2000),
        bodyTruncated: body.length > 2000,
        traceId: scalar(row["traceId"]),
        spanId: scalar(row["spanId"]),
        service: attrs["oneuptime.service.name"],
        cluster: attrs["oneuptime.kubernetes.cluster.name"],
        pod: attrs["resource.k8s.pod.name"],
      };
    }),
    note: "Stored severity may reflect stderr fallback. Organization filters require structured organization.id; text-only log context may not be indexed. Use get_trace from request search for correlation.",
  };
}

/** Compare fixed equal-duration windows around a verified deployment marker. */
export async function compareRelease(args: Args, apiKey: string): Promise<Row> {
  const service: string = required(args, "service");
  const environment: string = required(args, "environment");
  const cluster: string = required(args, "cluster");
  const lookupWindow: TimeWindow = parseTimeWindow({
    since: args["since"] || "24h",
    until: args["until"],
  });
  const minutes: number =
    args["windowMinutes"] === undefined ? 30 : Number(args["windowMinutes"]);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 360) {
    throw new Error("windowMinutes must be an integer from 5 to 360.");
  }
  const historyStart: string = new Date(
    Date.parse(lookupWindow.since) - minutes * 60000,
  ).toISOString();
  const eventQuery: Row = {
    time: {
      _type: "InBetween",
      startValue: historyStart,
      endValue: lookupWindow.until,
    },
    eventType: "deployment",
    attributes: {
      "deployment.status": { _type: "EqualTo", value: "completed" },
      "deployment.scope": { _type: "EqualTo", value: "speech-stack" },
      service: {
        _type: "Includes",
        value: [
          service,
          service.replace(/^kugelaudio-/, ""),
          `kugelaudio-${service.replace(/^kugelaudio-/, "")}`,
        ],
      },
      environment: { _type: "EqualTo", value: environment },
      cluster: { _type: "EqualTo", value: cluster },
    },
  };
  const result: Awaited<ReturnType<typeof readTelemetry>> = await readTelemetry(
    apiKey,
    "change-events",
    eventQuery,
    ["time", "title", "attributes", "primaryEntityId"],
    { maxRows: 1000, sort: { time: "DESC" } },
  );
  const missing: (reason: string) => Row = (reason: string): Row => {
    return {
      success: true,
      operation: "compare_release",
      assessment: "insufficient_data",
      reason,
      scope: { ...args, ...lookupWindow },
    };
  };
  if (result.truncated) {
    return missing(
      "Deployment history is truncated; narrow the lookup window.",
    );
  }
  const events: Row[] = Array.from(
    new Map(
      result.rows.map((r: Row) => {
        const attr: Row = attributes(r);
        return [
          String(
            attr["deployment.event_id"] ||
              `${scalar(r["time"])}:${attr["version"]}`,
          ),
          r,
        ] as const;
      }),
    ).values(),
  ).sort((a: Row, b: Row) => {
    return (
      Date.parse(String(scalar(b["time"]))) -
      Date.parse(String(scalar(a["time"])))
    );
  });
  const event: Row | undefined = events.find((r: Row) => {
    return (
      Date.parse(String(scalar(r["time"]))) >= Date.parse(lookupWindow.since) &&
      (!args["version"] || attributes(r)["version"] === args["version"])
    );
  });
  if (!event) {
    return missing(
      "No matching verified deployment event; emit release markers before comparing releases.",
    );
  }
  const version: unknown = attributes(event)["version"];
  const deployedAt: number = Date.parse(String(scalar(event["time"])));
  if (typeof version !== "string" || !version || !Number.isFinite(deployedAt)) {
    return missing("Deployment event is missing a valid version or timestamp.");
  }
  const duration: number = minutes * 60000;
  if (
    deployedAt + duration >
    Math.min(Date.now(), Date.parse(lookupWindow.until))
  ) {
    return missing(
      "The after-deployment window has not matured; retry after a full comparison window has elapsed.",
    );
  }
  if (
    events.some((r: Row) => {
      return (
        r !== event &&
        Date.parse(String(scalar(r["time"]))) > deployedAt - duration &&
        Date.parse(String(scalar(r["time"]))) < deployedAt + duration
      );
    })
  ) {
    return missing(
      "Another deployment overlaps the comparison windows; use a shorter window or a different release.",
    );
  }
  const before: TimeWindow = {
    since: new Date(deployedAt - duration).toISOString(),
    until: new Date(deployedAt).toISOString(),
  };
  const after: TimeWindow = {
    since: new Date(deployedAt).toISOString(),
    until: new Date(deployedAt + duration).toISOString(),
  };
  const [beforeQuery, afterQuery] = await Promise.all([
    scopedQuery({ ...args, version: undefined }, before, "startTime", apiKey),
    scopedQuery({ ...args, version }, after, "startTime", apiKey),
  ]);
  const [baseline, current]: Statistics[] = await Promise.all([
    statistics(apiKey, beforeQuery, before),
    statistics(apiKey, afterQuery, after),
  ]);
  const sufficient: boolean =
    baseline!.operations >= 30 &&
    current!.operations >= 30 &&
    !baseline!.truncated &&
    !current!.truncated;
  return {
    success: true,
    operation: "compare_release",
    assessment: sufficient ? "comparison_available" : "insufficient_data",
    ...(sufficient
      ? {}
      : {
          reason:
            "At least 30 recorded server operations and complete aggregates are required in each window.",
        }),
    scope: { service, environment, cluster },
    deployment: {
      version,
      time: new Date(deployedAt).toISOString(),
      eventId: attributes(event)["deployment.event_id"],
    },
    windows: { before, after },
    baseline,
    after: current,
    delta: sufficient
      ? {
          errorRatePercentagePoints:
            current!.errorRatePercent! - baseline!.errorRatePercent!,
          p95DurationMs:
            current!.p95DurationMs !== null && baseline!.p95DurationMs !== null
              ? current!.p95DurationMs - baseline!.p95DurationMs
              : null,
          operationsPerMinute:
            current!.operationsPerMinute - baseline!.operationsPerMinute,
        }
      : null,
    note: "Before includes all observed versions; after is restricted to the deployed version. Equal windows are time-correlated evidence, not proof of causation; traffic mix and overlapping rollouts may differ. Use search_requests/get_trace to inspect examples.",
  };
}
