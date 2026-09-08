import { McpToolInfo, JSONSchemaProperty } from "../Types/McpTypes";
import OneUptimeOperation from "../Types/OneUptimeOperation";
import ModelType from "../Types/ModelType";
import {
  investigateService,
  compareRelease,
  searchLogs,
  queryMetrics,
} from "../Services/ServiceInvestigation";

type Args = Record<string, unknown>;
const common: Record<string, JSONSchemaProperty> = {
  service: {
    type: "string",
    description:
      "Service name; tts, ingress, and normalizer resolve their known aliases.",
  },
  environment: {
    type: "string",
    description: "Deployment environment, e.g. production or staging.",
  },
  cluster: { type: "string", description: "Exact Kubernetes cluster name." },
  organization: {
    type: "string",
    description:
      "Numeric application organization ID or exact directory name/public ID.",
  },
  project: {
    type: "string",
    description: "Application project ID (not the OneUptime project).",
  },
  version: {
    type: "string",
    description: "Exact deployed service version/image tag.",
  },
  since: {
    type: "string",
    description:
      "Relative lookback (30m, 2h, 1d) or ISO timestamp; default 1h, maximum 7d.",
  },
  until: {
    type: "string",
    description: "ISO end timestamp with timezone; defaults to now.",
  },
};
interface Definition {
  name: string;
  description: string;
  required: string[];
  extra?: Record<string, JSONSchemaProperty>;
}
const definitions: Definition[] = [
  {
    name: "investigate_service",
    description:
      "Investigate a service: whole-window server-operation count, error rate and p95, grouped error operations and representative traces. Distinguishes no telemetry from no recorded errors; statistics are not estimated from sampled pages.",
    required: ["service"],
  },
  {
    name: "compare_release",
    description:
      "Compare equal windows around a verified deployment event in one cluster. Returns sample sizes and error/latency deltas; reports insufficient data for missing markers, immature/overlapping windows or fewer than 30 operations. Deduplicates repeated release markers. since defaults to 24h.",
    required: ["service", "environment", "cluster"],
    extra: {
      windowMinutes: {
        type: "integer",
        minimum: 5,
        maximum: 360,
        default: 30,
        description: "Duration of each before/after window.",
      },
    },
  },
  {
    name: "search_logs",
    description:
      "Find logs using readable service, workload, time, text and severity filters. Returns compact rows with trace IDs and explicit truncation. Text-only organization fields may not be indexed; use search_requests then get_trace for organization investigations.",
    required: [],
    extra: {
      skip: {
        type: "integer",
        minimum: 0,
        maximum: 100000,
        default: 0,
        description:
          "Use next.arguments from the previous response to keep the same time window.",
      },
      text: { type: "string", description: "Case-insensitive body substring." },
      severity: {
        type: "string",
        enum: ["info", "warning", "error", "fatal", "debug", "trace"],
        description: "Stored severity; may reflect stderr fallback.",
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
  },
  {
    name: "query_metrics",
    description:
      "Aggregate a named metric into time buckets, optionally grouped by attribute keys. Supports p50/p95/p99; returns native metric units and explicit truncation. Missing samples never become zeros. Cumulative counters need rate-aware interpretation.",
    required: ["metric"],
    extra: {
      metric: { type: "string", description: "Exact metric name." },
      aggregation: {
        type: "string",
        enum: ["Count", "Avg", "Sum", "Min", "Max", "P50", "P90", "P95", "P99"],
        default: "Avg",
      },
      interval: {
        type: "string",
        enum: [
          "Minute",
          "FiveMinutes",
          "FifteenMinutes",
          "ThirtyMinutes",
          "Hour",
          "Day",
          "Total",
        ],
        default: "FiveMinutes",
      },
      groupBy: {
        type: "array",
        items: { type: "string" },
        description: "Up to three attribute keys, e.g. resource.k8s.pod.name.",
      },
    },
  },
];
export function generateInvestigationTools(): McpToolInfo[] {
  return definitions.map((definition: Definition): McpToolInfo => {
    return {
      name: definition.name,
      title: definition.name.replace(/_/g, " "),
      description: definition.description,
      inputSchema: {
        type: "object",
        properties: { ...common, ...definition.extra },
        required: definition.required,
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      modelName: definition.name,
      tableName: definition.name,
      singularName: definition.name,
      pluralName: definition.name,
      operation: OneUptimeOperation.Read,
      modelType: ModelType.Analytics,
    };
  });
}
export function isInvestigationTool(name: string): boolean {
  return definitions.some((d: Definition) => {
    return d.name === name;
  });
}
export async function handleInvestigationTool(
  name: string,
  args: Args,
  apiKey: string,
): Promise<string> {
  const definition: Definition | undefined = definitions.find(
    (d: Definition) => {
      return d.name === name;
    },
  );
  if (!definition) {
    throw new Error(`Unknown investigation tool: ${name}`);
  }
  const allowed: Set<string> = new Set([
    ...Object.keys(common),
    ...Object.keys(definition.extra || {}),
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown parameter: ${key}`);
    }
  }
  const properties: Record<string, JSONSchemaProperty> = {
    ...common,
    ...definition.extra,
  };
  for (const [key, value] of Object.entries(args)) {
    const schema: JSONSchemaProperty | undefined = properties[key];
    if (schema?.type === "string" && typeof value !== "string") {
      throw new Error(`${key} must be a string.`);
    }
    if (
      schema?.type === "integer" &&
      (typeof value !== "number" || !Number.isInteger(value))
    ) {
      throw new Error(`${key} must be an integer.`);
    }
    if (schema?.type === "array" && !Array.isArray(value)) {
      throw new Error(`${key} must be an array.`);
    }
  }
  if (!apiKey) {
    throw new Error("A project-scoped API key is required.");
  }
  switch (name) {
    case "investigate_service":
      return JSON.stringify(await investigateService(args, apiKey));
    case "compare_release":
      return JSON.stringify(await compareRelease(args, apiKey));
    case "search_logs":
      return JSON.stringify(await searchLogs(args, apiKey));
    case "query_metrics":
      return JSON.stringify(await queryMetrics(args, apiKey));
    default:
      throw new Error(`Unknown investigation tool: ${name}`);
  }
}
