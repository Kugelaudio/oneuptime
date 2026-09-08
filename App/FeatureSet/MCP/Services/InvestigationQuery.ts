import OneUptimeApiService from "./OneUptimeApiService";
import { JSONObject } from "Common/Types/JSON";

const ISO_TIMESTAMP: RegExp = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/;

export type TimeWindow = { since: string; until: string };

const ORGANIZATION_ID: RegExp = /^[1-9]\d*$/;

export function parseOrganizationId(value: unknown): string {
  if (typeof value !== "string" || !ORGANIZATION_ID.test(value)) {
    throw new Error(
      'organization must be a positive numeric ID string, for example "13".',
    );
  }
  return value;
}

export function scalar(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const tagged: Record<string, unknown> = value as Record<string, unknown>;
    if (typeof tagged["_type"] === "string" && "value" in tagged) {
      return scalar(tagged["value"]);
    }
  }
  return value;
}

export function parseTimeWindow(
  args: { since?: unknown; until?: unknown },
  now: Date = new Date(),
): TimeWindow {
  const until: unknown = args.until ?? now.toISOString();
  if (
    typeof until !== "string" ||
    !ISO_TIMESTAMP.test(until) ||
    !Number.isFinite(Date.parse(until))
  ) {
    throw new Error("until must be an ISO timestamp with a timezone.");
  }
  const input: unknown = args.since ?? "1h";
  if (typeof input !== "string") {
    throw new Error(
      "since must be a duration such as 30m or an ISO timestamp.",
    );
  }
  const relative: RegExpMatchArray | null = input.match(/^(\d+)(m|h|d)$/);
  const units: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
  const end: number = Date.parse(until);
  const start: number = relative
    ? end - Number(relative[1]) * units[relative[2]!]!
    : ISO_TIMESTAMP.test(input)
      ? Date.parse(input)
      : NaN;
  if (!Number.isFinite(start) || start >= end || end - start > 7 * 86400000) {
    throw new Error(
      "Time window must be positive and at most 7 days; use ISO timestamps or a duration such as 30m.",
    );
  }
  return {
    since: new Date(start).toISOString(),
    until: new Date(end).toISOString(),
  };
}

export function telemetryQuery(
  args: Record<string, unknown>,
  window: TimeWindow,
  timeColumn: string,
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    [timeColumn]: {
      _type: "InBetween",
      startValue: window.since,
      endValue: window.until,
    },
  };
  const attributes: Record<string, unknown> = {};
  const keys: Record<string, string> = {
    environment:
      timeColumn === "startTime"
        ? "resource.deployment.environment.name"
        : "resource.oneuptime.label.environment",
    version: "resource.service.version",
    cluster: "oneuptime.kubernetes.cluster.name",
    project: "project.id",
  };
  for (const [arg, key] of Object.entries(keys)) {
    if (args[arg] !== undefined) {
      if (typeof args[arg] !== "string" || !(args[arg] as string).trim()) {
        throw new Error(`${arg} must be a non-empty string.`);
      }
      attributes[key] = { _type: "EqualTo", value: args[arg] };
    }
  }
  if (args["service"] !== undefined) {
    if (typeof args["service"] !== "string" || !args["service"].trim()) {
      throw new Error("service must be a non-empty string.");
    }
    const aliases: Record<string, string[]> = {
      tts: ["tts", "kugelaudio-tts", "tts-tts-kugel-3"],
      ingress: ["ingress", "kugelaudio-ingress"],
      normalizer: ["normalizer", "kugelaudio-normalizer"],
    };
    attributes["oneuptime.service.name"] = {
      _type: "Includes",
      value: aliases[args["service"]] ?? [args["service"]],
    };
  }
  if (Object.keys(attributes).length) {
    query["attributes"] = attributes;
  }
  return query;
}

export async function readTelemetry(
  apiKey: string,
  resource: "span" | "logs" | "change-events" | "metrics",
  query: Record<string, unknown>,
  select: string[],
  options: {
    maxRows?: number;
    skip?: number;
    sort?: Record<string, string>;
  } = {},
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const maxRows: number = options.maxRows ?? 1000;
  const skip: number = options.skip ?? 0;
  if (!Number.isInteger(skip) || skip < 0 || skip > 100000) {
    throw new Error("skip must be an integer between 0 and 100000.");
  }
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10000) {
    throw new Error("maxRows must be an integer between 1 and 10000.");
  }
  /*
   * Equal telemetry timestamps are common; a unique final key keeps offset
   * pages deterministic for the same stored rows and fixed time window.
   */
  const sort: Record<string, string> = {
    ...(options.sort ?? {
      [resource === "span" ? "startTime" : "time"]: "DESC",
    }),
    _id: options.sort?.["_id"] ?? "ASC",
  };
  const rows: Record<string, unknown>[] = [];
  let previousPage: string | undefined;
  while (rows.length < maxRows) {
    const limit: number = Math.min(250, maxRows - rows.length);
    const response: unknown =
      await OneUptimeApiService.makeAuthenticatedApiCall({
        method: "POST",
        path: `/api/${resource}/get-list?skip=${skip + rows.length}&limit=${limit}`,
        apiKey,
        body: {
          query,
          select: Object.fromEntries(
            select.map((field: string): [string, boolean] => {
              return [field, true];
            }),
          ),
          sort,
        } as JSONObject,
      });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error(
        `Malformed ${resource} response: expected a list envelope.`,
      );
    }
    const envelope: Record<string, unknown> = response as Record<
      string,
      unknown
    >;
    const page: unknown = envelope["data"];
    if (
      !Array.isArray(page) ||
      page.some((row: unknown): boolean => {
        return !row || typeof row !== "object" || Array.isArray(row);
      }) ||
      page.length > limit
    ) {
      throw new Error(`Malformed ${resource} response: invalid data page.`);
    }
    const serialized: string = JSON.stringify(page);
    if (page.length && serialized === previousPage) {
      throw new Error(
        `Pagination did not advance for ${resource}; results cannot be trusted.`,
      );
    }
    previousPage = serialized;
    rows.push(...(page as Record<string, unknown>[]));
    const hasMore: unknown = envelope["hasMore"];
    if (hasMore !== undefined && typeof hasMore !== "boolean") {
      throw new Error(
        `Malformed ${resource} response: hasMore must be a boolean.`,
      );
    }
    if (hasMore === true && !page.length) {
      throw new Error(
        `Malformed ${resource} response: empty page with hasMore.`,
      );
    }
    if (hasMore === false || (hasMore === undefined && page.length < limit)) {
      return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}
