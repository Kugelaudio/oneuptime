import { JSONSchema, JSONSchemaProperty, McpToolInfo } from "../Types/McpTypes";
import OneUptimeOperation from "../Types/OneUptimeOperation";
import ModelType from "../Types/ModelType";
import { searchRequests, getTrace } from "../Services/RequestInvestigation";

const TIME_PROPERTIES: Record<string, JSONSchemaProperty> = {
  since: {
    type: "string",
    description:
      "Relative to until (30m, 2h, 7d) or ISO timestamp with timezone. Default 1h; maximum window 7 days.",
  },
  until: {
    type: "string",
    description: "ISO timestamp with timezone. Default now.",
  },
};

export function generateRequestTools(): McpToolInfo[] {
  return [
    {
      name: "search_requests",
      title: "Search Requests",
      description:
        "Find HTTP requests and logical WebSocket TTS generations by organization, service and time, with outcome, duration and trace IDs. Uses positive numeric application organization IDs and application project IDs. Connection IDs remain separate from generation IDs. Results describe bounded observed telemetry, not billing totals; narrow the window when truncated.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...TIME_PROPERTIES,
          organization: {
            type: "string",
            pattern: "^[1-9]\\d*$",
            description:
              'Positive numeric application organization ID as a string, for example "13".',
          },
          project: {
            type: "string",
            description: "Exact application project ID from telemetry.",
          },
          service: {
            type: "string",
            description:
              "Service name; tts, ingress and normalizer include their known aliases.",
          },
          environment: {
            type: "string",
            description: "Environment, for example production or staging.",
          },
          cluster: {
            type: "string",
            description: "Exact Kubernetes cluster name.",
          },
          endpoint: {
            type: "string",
            description: "Exact HTTP route or path.",
          },
          version: {
            type: "string",
            description: "Exact deployed service version.",
          },
          status: {
            type: "string",
            enum: ["error", "success", "cancelled", "recovered", "unknown"],
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          skip: {
            type: "integer",
            minimum: 0,
            maximum: 1000,
            default: 0,
            description:
              "Offset among observed requests; use the returned next arguments to keep the time window fixed.",
          },
        },
      },
    },
    {
      name: "get_trace",
      title: "Get Trace",
      description:
        "Inspect a trace with chronologically ordered spans, parent IDs and tree depth, correlated logs, failures, slowest operations and workload attributes. Retrieves untagged child spans as well as organization-bearing spans. Reports missing parents, caps and uncertain coverage; linked WebSocket connection traces remain separate.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["traceId"],
        properties: {
          ...TIME_PROPERTIES,
          traceId: {
            type: "string",
            pattern: "^[0-9a-fA-F]{32}$",
            description: "OpenTelemetry trace ID returned by search_requests.",
          },
        },
      },
    },
  ].map(
    (definition: {
      name: string;
      title: string;
      description: string;
      inputSchema: JSONSchema;
    }): McpToolInfo => {
      return {
        ...definition,
        annotations: { readOnlyHint: true, idempotentHint: true },
        modelName: "Investigation",
        operation: OneUptimeOperation.Read,
        modelType: ModelType.Analytics,
        singularName: definition.title,
        pluralName: definition.title,
        tableName: "Investigation",
        apiPath: "",
      };
    },
  );
}

export function isRequestTool(name: string): boolean {
  return name === "search_requests" || name === "get_trace";
}

export async function handleRequestTool(
  name: string,
  args: Record<string, unknown>,
  apiKey: string,
): Promise<string> {
  const schemas: McpToolInfo[] = generateRequestTools();
  const tool: McpToolInfo | undefined = schemas.find(
    (candidate: McpToolInfo): boolean => {
      return candidate.name === name;
    },
  );
  if (!tool) {
    throw new Error(`Unknown request tool: ${name}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema: JSONSchemaProperty | undefined =
      tool.inputSchema.properties?.[key];
    if (schema?.type === "string" && typeof value !== "string") {
      throw new Error(`${key} must be a string.`);
    }
    if (
      schema?.type === "integer" &&
      (typeof value !== "number" || !Number.isInteger(value))
    ) {
      throw new Error(`${key} must be an integer.`);
    }
  }
  const unknown: string[] = Object.keys(args).filter((key: string): boolean => {
    return !(key in tool.inputSchema.properties!);
  });
  if (unknown.length) {
    throw new Error(`Unknown arguments: ${unknown.join(", ")}`);
  }
  const data: Record<string, unknown> =
    name === "search_requests"
      ? await searchRequests(args, apiKey)
      : await getTrace(args, apiKey);
  return JSON.stringify({ success: true, data });
}
