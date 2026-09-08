/** Converts model Zod schemas to the JSON Schema contract exposed over MCP. */
import { JSONSchemaProperty } from "../Types/McpTypes";
import { ModelSchemaType } from "Common/Utils/Schema/ModelSchema";
import { AnalyticsModelSchemaType } from "Common/Utils/Schema/AnalyticsModelSchema";

interface ZodField {
  _def?: {
    typeName?: string;
    innerType?: ZodField;
    schema?: ZodField;
    type?: ZodField;
    valueType?: ZodField;
    shape?: () => Record<string, ZodField>;
    options?: ZodField[];
    values?: Array<string | number | boolean>;
    value?: string | number | boolean | null;
    description?: string;
    unknownKeys?: string;
    defaultValue?: () => unknown;
    openapi?: { metadata?: JSONSchemaProperty & { example?: unknown } };
  };
}

export interface ZodToJsonSchemaResult {
  type: string;
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties: boolean;
}

export function zodToJsonSchema(
  zodSchema: ModelSchemaType | AnalyticsModelSchemaType,
): ZodToJsonSchemaResult {
  const field: ZodField = zodSchema as unknown as ZodField;
  if (!field._def?.shape) {
    throw new Error("MCP model schema must be a Zod object");
  }
  return convertObject(field) as ZodToJsonSchemaResult;
}

function convertObject(field: ZodField): JSONSchemaProperty {
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(field._def!.shape!())) {
    properties[key] = convertField(value, key);
    if (!["ZodOptional", "ZodDefault"].includes(value._def?.typeName || "")) {
      required.push(key);
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties: field._def?.unknownKeys === "passthrough",
    ...(required.length ? { required } : {}),
  };
}

function convertField(field: ZodField, key: string): JSONSchemaProperty {
  const def: NonNullable<ZodField["_def"]> = field._def || {};
  let property: JSONSchemaProperty;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      property = convertField(def.innerType!, key);
      if (def.defaultValue) {
        property.default = def.defaultValue();
      }
      break;
    case "ZodNullable":
      property = {
        anyOf: [convertField(def.innerType!, key), { type: "null" }],
      };
      break;
    case "ZodEffects":
      property = convertField(def.schema!, key);
      break;
    case "ZodObject":
      property = convertObject(field);
      break;
    case "ZodRecord":
      property = {
        type: "object",
        additionalProperties: convertField(def.valueType!, key),
      };
      break;
    case "ZodUnion":
      property = {
        anyOf: def.options!.map((option: ZodField) => {
          return convertField(option, key);
        }),
      };
      break;
    case "ZodArray":
      // Entity arrays use their published reference schema, avoiding recursive model expansion.
      property = {
        type: "array",
        items: def.openapi?.metadata?.items || convertField(def.type!, key),
      };
      break;
    case "ZodEnum":
      property = { type: "string", enum: def.values! };
      break;
    case "ZodLiteral":
      property =
        def.value === null
          ? { type: "null" }
          : { type: typeof def.value, enum: [def.value!] };
      break;
    case "ZodDate":
      property = { type: "string", format: "date-time" };
      break;
    case "ZodString":
      property = { type: "string" };
      break;
    case "ZodNumber":
      property = { type: "number" };
      break;
    case "ZodBoolean":
      property = { type: "boolean" };
      break;
    case "ZodNull":
      property = { type: "null" };
      break;
    case "ZodAny":
    case "ZodUnknown":
      property = {};
      break;
    default:
      if (def.openapi?.metadata?.type) {
        property = { type: def.openapi.metadata.type };
      } else {
        throw new Error(
          `Unsupported Zod schema for ${key}: ${def.typeName || "unknown"}`,
        );
      }
  }
  const metadata: (JSONSchemaProperty & { example?: unknown }) | undefined =
    def.openapi?.metadata;
  // Metadata describes presentation; it must not narrow a union to one type.
  if (metadata) {
    if (!property.type && !property.anyOf && metadata.type) {
      property.type = metadata.type;
    }
    if (metadata.enum?.length) {
      property.enum = metadata.enum;
    }
    if (metadata.format) {
      property.format = metadata.format;
    }
    if (metadata.default !== undefined) {
      property.default = metadata.default;
    }
    if (metadata.items && !property.items) {
      property.items = metadata.items;
    }
    if (metadata.example !== undefined) {
      (property as JSONSchemaProperty & { example?: unknown }).example =
        metadata.example;
    }
  }
  const description: string | undefined =
    def.description || metadata?.description;
  if (description) {
    property.description = cleanFieldDescription(description);
  }
  return property;
}
/**
 * Clean up description by removing permission information
 */
export function cleanFieldDescription(description: string): string {
  if (!description) {
    return description;
  }

  // Remove everything after ". Permissions -"
  const permissionsIndex: number = description.indexOf(". Permissions -");
  if (permissionsIndex !== -1) {
    const beforeText: string = description.substring(0, permissionsIndex);
    return addPeriodIfNeeded(beforeText);
  }

  // Handle cases where it starts with "Permissions -" without a preceding sentence
  const permissionsStartIndex: number = description.indexOf("Permissions -");
  if (permissionsStartIndex !== -1) {
    const beforePermissions: string = description
      .substring(0, permissionsStartIndex)
      .trim();
    if (beforePermissions && beforePermissions.length > 0) {
      return addPeriodIfNeeded(beforePermissions);
    }
  }

  return description;
}

/**
 * Add period to text if it doesn't end with punctuation
 */
function addPeriodIfNeeded(text: string): string {
  if (!text) {
    return text;
  }

  const punctuation: string[] = [".", "!", "?"];
  const lastChar: string = text.charAt(text.length - 1);

  if (punctuation.includes(lastChar)) {
    return text;
  }

  return text + ".";
}

/**
 * Sanitize a name to be valid for MCP tool names
 * MCP tool names can only contain [a-z0-9_-]
 */
export function sanitizeToolName(name: string): string {
  return (
    name
      // Convert camelCase to snake_case
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      // Replace non-alphanumeric characters with underscores
      .replace(/[^a-z0-9]/g, "_")
      // Replace multiple consecutive underscores with single underscore
      .replace(/_+/g, "_")
      // Remove leading/trailing underscores
      .replace(/^_|_$/g, "")
  );
}
