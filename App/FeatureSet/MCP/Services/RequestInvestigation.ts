import {
  parseTimeWindow,
  parseOrganizationId,
  telemetryQuery,
  readTelemetry,
  scalar,
  TimeWindow,
} from "./InvestigationQuery";

const TRACE_ID: RegExp = /^[0-9a-f]{32}$/i;
const EMPTY_SPAN_ID: RegExp = /^0+$/;

type Row = Record<string, unknown>;
const SPAN_FIELDS: string[] = [
  "traceId",
  "spanId",
  "parentSpanId",
  "name",
  "kind",
  "startTime",
  "endTime",
  "durationUnixNano",
  "statusCode",
  "statusMessage",
  "hasException",
  "attributes",
  "links",
];

function attributes(row: Row): Row {
  const value: unknown = row["attributes"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function attr(row: Row, key: string): unknown {
  return scalar(attributes(row)[key]);
}

function text(value: unknown): string | null {
  const result: unknown = scalar(value);
  return typeof result === "string" && result.length ? result : null;
}

function duration(row: Row): number | null {
  const value: unknown = scalar(row["durationUnixNano"]);
  if (value === null || value === undefined) {
    return null;
  }
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error("Invalid span durationUnixNano returned by telemetry API.");
  }
  return Number(value) / 1000000;
}

function outcome(row: Row): string {
  const turnOutcome: unknown = attr(row, "kugelaudio.tts.outcome");
  if (typeof turnOutcome === "string") {
    return turnOutcome;
  }
  const http: number = Number(
    attr(row, "http.response.status_code") ?? attr(row, "http.status_code"),
  );
  if (
    scalar(row["statusCode"]) === 2 ||
    scalar(row["hasException"]) === true ||
    http >= 400
  ) {
    return "error";
  }
  if (scalar(row["statusCode"]) === 1 || (http >= 100 && http < 400)) {
    return "success";
  }
  return "unknown";
}

function isHttp(row: Row): boolean {
  return (
    scalar(row["kind"]) === "SPAN_KIND_SERVER" &&
    attr(row, "asgi.scope.type") !== "websocket" &&
    Boolean(attr(row, "http.request.method") ?? attr(row, "http.method"))
  );
}

function id(row: Row): string {
  const spanId: string | null = text(row["spanId"]);
  const traceId: string | null = text(row["traceId"]);
  if (!spanId || !traceId) {
    throw new Error(
      "Span is missing traceId or spanId; cannot reconstruct requests.",
    );
  }
  return `${traceId}:${spanId}`;
}

function descendants(root: Row, children: Map<string, Row[]>): Row[] {
  const selected: Map<string, Row> = new Map();
  const pending: Row[] = [root];
  while (pending.length) {
    const row: Row = pending.pop()!;
    const key: string = id(row);
    if (selected.has(key)) {
      continue;
    }
    selected.set(key, row);
    pending.push(...(children.get(key) ?? []));
  }
  return [...selected.values()];
}

function requestSummary(root: Row, members: Row[]): Row {
  const turns: Row[] = members.filter((row: Row): boolean => {
    return scalar(row["name"]) === "tts.turn";
  });
  const pick: (key: string) => unknown = (key: string): unknown => {
    for (const row of [root, ...turns, ...members]) {
      const value: unknown = attr(row, key);
      if (value !== undefined && value !== "") {
        return value;
      }
    }
    return null;
  };
  const knownOutcomes: string[] = [outcome(root), ...turns.map(outcome)];
  const requestOutcome: string =
    ["error", "cancelled", "recovered", "success"].find(
      (value: string): boolean => {
        return knownOutcomes.includes(value);
      },
    ) ?? "unknown";
  return {
    requestId: id(root),
    traceId: text(root["traceId"]),
    spanId: text(root["spanId"]),
    kind: isHttp(root) ? "http" : "generation",
    name: scalar(root["name"]),
    time: scalar(root["startTime"]),
    durationMs: duration(root),
    outcome: requestOutcome,
    organizationId: pick("organization.id"),
    projectId: pick("project.id"),
    connectionId: pick("connection.id"),
    generationId: pick("generation.id"),
    generationSequence: pick("generation.sequence"),
    endpoint:
      attr(root, "http.route") ??
      attr(root, "url.path") ??
      attr(root, "http.target") ??
      null,
    transport: pick("kugelaudio.tts.transport"),
    service: pick("oneuptime.service.name"),
    version: pick("resource.service.version"),
    model: pick("kugelaudio.model.id") ?? pick("model.id"),
    observedSpanCount: members.length,
  };
}

export async function searchRequests(args: Row, apiKey: string): Promise<Row> {
  const window: TimeWindow = parseTimeWindow(args);
  const limit: unknown = args["limit"] ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new Error("limit must be an integer between 1 and 100.");
  }
  const skip: unknown = args["skip"] ?? 0;
  if (!Number.isInteger(skip) || Number(skip) < 0 || Number(skip) > 1000) {
    throw new Error("skip must be an integer between 0 and 1000.");
  }
  const status: unknown = args["status"];
  if (
    status !== undefined &&
    (typeof status !== "string" ||
      !["error", "success", "cancelled", "recovered", "unknown"].includes(
        status,
      ))
  ) {
    throw new Error("Unsupported request status.");
  }
  if (
    args["endpoint"] !== undefined &&
    (typeof args["endpoint"] !== "string" || !args["endpoint"].trim())
  ) {
    throw new Error("endpoint must be a non-empty string.");
  }
  const organizationId: string | undefined =
    args["organization"] === undefined
      ? undefined
      : parseOrganizationId(args["organization"]);
  const query: Row = telemetryQuery(args, window, "startTime");
  if (organizationId) {
    query["attributes"] = {
      ...(query["attributes"] as Row),
      "organization.id": { _type: "EqualTo", value: organizationId },
    };
  }
  const evidence: { rows: Row[]; truncated: boolean } = await readTelemetry(
    apiKey,
    "span",
    query,
    SPAN_FIELDS,
    {
      maxRows: 2000,
      sort: { startTime: "DESC", traceId: "ASC", spanId: "ASC" },
    },
  );
  const traceIds: string[] = [
    ...new Set(
      evidence.rows.map((row: Row): string => {
        id(row);
        return text(row["traceId"])!;
      }),
    ),
  ];
  const selectedTraces: string[] = traceIds.slice(0, 100);
  const expanded: { rows: Row[]; truncated: boolean } = selectedTraces.length
    ? await readTelemetry(
        apiKey,
        "span",
        {
          ...telemetryQuery({}, window, "startTime"),
          traceId: { _type: "Includes", value: selectedTraces },
        },
        SPAN_FIELDS,
        {
          maxRows: 5000,
          sort: { startTime: "DESC", traceId: "ASC", spanId: "ASC" },
        },
      )
    : { rows: [], truncated: false };
  const unique: Map<string, Row> = new Map();
  for (const row of [
    ...expanded.rows,
    ...evidence.rows.filter((row: Row): boolean => {
      return selectedTraces.includes(text(row["traceId"])!);
    }),
  ]) {
    unique.set(id(row), row);
  }
  const rows: Row[] = [...unique.values()];
  const roots: Row[] = rows.filter((row: Row): boolean => {
    return isHttp(row) || scalar(row["name"]) === "tts.turn";
  });
  const evidenceIds: Set<string> = new Set(evidence.rows.map(id));
  const children: Map<string, Row[]> = new Map();
  for (const row of rows) {
    const parentKey: string = `${text(row["traceId"])}:${text(row["parentSpanId"])}`;
    const siblings: Row[] = children.get(parentKey) ?? [];
    siblings.push(row);
    children.set(parentKey, siblings);
  }
  const groups: Map<string, Row[]> = new Map(
    roots.map((root: Row): [string, Row[]] => {
      return [id(root), descendants(root, children)];
    }),
  );
  const ownedRequests: Set<string> = new Set();
  for (const root of roots) {
    for (const member of groups.get(id(root))!) {
      if (
        id(member) !== id(root) &&
        (isHttp(member) || scalar(member["name"]) === "tts.turn")
      ) {
        ownedRequests.add(id(member));
      }
    }
  }
  const requests: Row[] = [];
  for (const root of roots) {
    const members: Row[] = groups.get(id(root))!;
    /*
     * The outer request or generation owns all downstream HTTP calls and turns.
     * A WebSocket generation stays separate from its linked connection trace.
     */
    if (ownedRequests.has(id(root))) {
      continue;
    }
    if (
      !members.some((row: Row): boolean => {
        return evidenceIds.has(id(row));
      })
    ) {
      continue;
    }
    const organizations: Set<string> = new Set(
      members
        .map((row: Row): string | null => {
          return text(attr(row, "organization.id"));
        })
        .filter((value: string | null): value is string => {
          return value !== null;
        }),
    );
    if (
      organizationId &&
      (organizations.size !== 1 || !organizations.has(organizationId))
    ) {
      continue;
    }
    const summary: Row = requestSummary(root, members);
    if (
      args["project"] !== undefined &&
      summary["projectId"] !== args["project"]
    ) {
      continue;
    }
    if (status !== undefined && summary["outcome"] !== status) {
      continue;
    }
    if (
      args["endpoint"] !== undefined &&
      summary["endpoint"] !== args["endpoint"]
    ) {
      continue;
    }
    requests.push(summary);
  }
  requests.sort((left: Row, right: Row): number => {
    return (
      String(right["time"]).localeCompare(String(left["time"])) ||
      String(left["requestId"]).localeCompare(String(right["requestId"]))
    );
  });
  const scanTruncated: boolean =
    evidence.truncated ||
    expanded.truncated ||
    traceIds.length > selectedTraces.length;
  const pageEnd: number = Number(skip) + Number(limit);
  const hasMore: boolean = requests.length > pageEnd;
  const truncated: boolean = scanTruncated || hasMore;
  return {
    requests: requests.slice(Number(skip), pageEnd),
    scope: { ...args, ...window, organizationId },
    next: hasMore
      ? {
          tool: "search_requests",
          arguments: { ...args, ...window, skip: pageEnd },
        }
      : null,
    coverage: {
      state: !requests.length
        ? "insufficient_data"
        : truncated
          ? "partial"
          : "observed",
      truncated,
      scanTruncated,
      candidateSpans: evidence.rows.length,
      expandedSpans: expanded.rows.length,
      matchedRequests: requests.length,
      scannedTraceCount: selectedTraces.length,
      note: "Only observed HTTP server requests and tts.turn generations are classified. Sampling, retention, missing spans and the time window can hide requests. Follow next to page through observed matches; narrow the window if scanTruncated.",
    },
  };
}

export async function getTrace(args: Row, apiKey: string): Promise<Row> {
  const traceInput: unknown = args["traceId"];
  if (typeof traceInput !== "string" || !TRACE_ID.test(traceInput)) {
    throw new Error("traceId must contain 32 hexadecimal characters.");
  }
  const traceId: string = traceInput.toLowerCase();
  const window: TimeWindow = parseTimeWindow(args);
  const [spans, logs]: [
    { rows: Row[]; truncated: boolean },
    { rows: Row[]; truncated: boolean },
  ] = await Promise.all([
    readTelemetry(
      apiKey,
      "span",
      { ...telemetryQuery({}, window, "startTime"), traceId },
      SPAN_FIELDS,
      { maxRows: 2000, sort: { startTime: "ASC", spanId: "ASC" } },
    ),
    readTelemetry(
      apiKey,
      "logs",
      { ...telemetryQuery({}, window, "time"), traceId },
      ["time", "body", "severityText", "traceId", "spanId", "attributes"],
      { maxRows: 200, sort: { time: "ASC" } },
    ),
  ]);
  const byId: Map<string, Row> = new Map(
    spans.rows.map((row: Row): [string, Row] => {
      id(row);
      return [text(row["spanId"])!, row];
    }),
  );
  const missingParents: Set<string> = new Set();
  const cyclicSpans: Set<string> = new Set();
  const ordered: Row[] = spans.rows.map((row: Row): Row => {
    let current: Row = row;
    let depth: number = 0;
    const seen: Set<string> = new Set([text(row["spanId"])!]);
    while (
      text(current["parentSpanId"]) &&
      !EMPTY_SPAN_ID.test(text(current["parentSpanId"])!)
    ) {
      const parentId: string = text(current["parentSpanId"])!;
      if (seen.has(parentId)) {
        cyclicSpans.add(text(row["spanId"])!);
        break;
      }
      seen.add(parentId);
      const parent: Row | undefined = byId.get(parentId);
      if (!parent) {
        missingParents.add(parentId);
        break;
      }
      depth++;
      current = parent;
    }
    return {
      ...row,
      startTime: scalar(row["startTime"]),
      endTime: scalar(row["endTime"]),
      depth,
      durationMs: duration(row),
      outcome: outcome(row),
    };
  });
  ordered.sort((left: Row, right: Row): number => {
    return String(left["startTime"]).localeCompare(String(right["startTime"]));
  });
  const truncated: boolean = spans.truncated || logs.truncated;
  return {
    traceId,
    scope: window,
    spans: ordered,
    logs: logs.rows,
    failures: ordered
      .filter((row: Row): boolean => {
        return row["outcome"] === "error";
      })
      .map((row: Row): Row => {
        return {
          spanId: row["spanId"],
          name: row["name"],
          message: row["statusMessage"],
        };
      }),
    slowestSpans: [...ordered]
      .filter((row: Row): boolean => {
        return typeof row["durationMs"] === "number";
      })
      .sort((left: Row, right: Row): number => {
        return Number(right["durationMs"]) - Number(left["durationMs"]);
      })
      .slice(0, 5)
      .map((row: Row): Row => {
        return {
          spanId: row["spanId"],
          name: row["name"],
          durationMs: row["durationMs"],
        };
      }),
    coverage: {
      state: !ordered.length
        ? "insufficient_data"
        : truncated || missingParents.size || cyclicSpans.size
          ? "partial"
          : "observed",
      truncated,
      spansTruncated: spans.truncated,
      logsTruncated: logs.truncated,
      missingParentSpanIds: [...missingParents],
      cyclicSpanIds: [...cyclicSpans],
      note: "All returned records are within the requested window. Sampling, retention and pending ingestion mean absence of missing parents does not prove the trace is complete; linked connection traces are separate.",
    },
  };
}
