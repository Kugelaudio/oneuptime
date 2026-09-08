/**
 * formatToolResponse envelope tests.
 *
 * Locks in the structured response envelopes returned to MCP clients:
 * - list envelopes carry pagination metadata (returnedCount/totalCount/
 *   skip/limit/hasMore) computed from the request args plus the API's total
 *   count, and items are NOT truncated.
 * - update envelopes carry no data field (the API returns an empty body) and
 *   point the agent at the corresponding get_* tool.
 * - read not-found envelopes suggest the sanitized list_* tool name.
 */

import { describe, it, expect } from "@jest/globals";
import { formatToolResponse } from "../Handlers/ToolHandler";
import { McpToolInfo, OneUptimeToolCallArgs } from "../Types/McpTypes";
import OneUptimeOperation from "../Types/OneUptimeOperation";
import ModelType from "../Types/ModelType";
import { JSONObject } from "Common/Types/JSON";

function makeTool(
  operation: OneUptimeOperation,
  singularName: string = "Incident",
  pluralName: string = "Incidents",
): McpToolInfo {
  return {
    name: `${operation}_test_tool`,
    description: "Test tool",
    inputSchema: { type: "object", properties: {} },
    modelName: singularName,
    operation,
    modelType: ModelType.Database,
    singularName,
    pluralName,
    tableName: singularName,
    apiPath: "/incident",
  };
}

function makeItems(count: number): Array<JSONObject> {
  return Array.from({ length: count }, (_: unknown, index: number) => {
    return { _id: `id-${index}`, title: `Item ${index}` } as JSONObject;
  });
}

describe("formatToolResponse", () => {
  describe("list responses", () => {
    it("computes hasMore=true from skip + returned items vs total count", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { data: makeItems(5), count: 12 },
        { skip: 0, limit: 5 } as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(true);
      expect(result["operation"]).toBe("list");
      expect(result["resourceType"]).toBe("Incidents");
      expect(result["returnedCount"]).toBe(5);
      expect(result["totalCount"]).toBe(12);
      expect(result["skip"]).toBe(0);
      expect(result["limit"]).toBe(5);
      expect(result["hasMore"]).toBe(true);
      expect(result["data"]).toHaveLength(5);
      expect(result["note"]).toContain("skip=5");
    });

    it("computes hasMore=false when all matching rows were returned", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { data: makeItems(3), count: 3 },
        { limit: 10 } as OneUptimeToolCallArgs,
      );

      expect(result["returnedCount"]).toBe(3);
      expect(result["totalCount"]).toBe(3);
      expect(result["hasMore"]).toBe(false);
      expect(result["note"]).toBeUndefined();
    });

    it("does NOT truncate items (no preview limit)", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { data: makeItems(25), count: 100 },
        { limit: 25 } as OneUptimeToolCallArgs,
      );

      expect(result["data"]).toHaveLength(25);
      expect(result["returnedCount"]).toBe(25);
      expect(result["totalCount"]).toBe(100);
      expect(result["hasMore"]).toBe(true);
    });

    it("accounts for skip when computing hasMore", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { data: makeItems(5), count: 10 },
        { skip: 5, limit: 5 } as OneUptimeToolCallArgs,
      );

      // skip(5) + returned(5) === total(10): nothing left.
      expect(result["hasMore"]).toBe(false);
    });

    it("reports unknown pagination when a full page lacks API metadata", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        makeItems(10),
        {} as OneUptimeToolCallArgs,
      );

      // A full page alone does not prove whether a next page exists.
      expect(result["totalCount"]).toBeNull();
      expect(result["returnedCount"]).toBe(10);
      expect(result["hasMore"]).toBeNull();
    });

    it("reports an empty result set with a friendly message", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { data: [], count: 0 },
        {} as OneUptimeToolCallArgs,
      );

      expect(result["returnedCount"]).toBe(0);
      expect(result["hasMore"]).toBe(false);
      expect(result["message"]).toContain("No Incidents found");
    });
  });

  describe("update responses", () => {
    it("has no data field and points at the get_* tool", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(
          OneUptimeOperation.Update,
          "On-Call Duty Policy",
          "On-Call Duty Policies",
        ),
        undefined,
        { id: "abc-123" } as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(true);
      expect(result["operation"]).toBe("update");
      expect(result["resourceId"]).toBe("abc-123");
      // The API returns an empty body on update — no data must be fabricated.
      expect("data" in result).toBe(false);
      expect(result["message"]).toContain("Successfully updated");
      expect(result["note"]).toContain("get_on_call_duty_policy");
    });
  });

  describe("read responses", () => {
    it("wraps a found record", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.Read),
        { _id: "abc", title: "Found" },
        { id: "abc" } as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(true);
      expect(result["operation"]).toBe("read");
      expect((result["data"] as JSONObject)["title"]).toBe("Found");
    });

    it("suggests the sanitized list tool name when not found", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(
          OneUptimeOperation.Read,
          "On-Call Duty Policy",
          "On-Call Duty Policies",
        ),
        null,
        { id: "missing-id" } as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(false);
      expect(result["error"]).toContain("missing-id");
      expect(result["suggestion"]).toContain("list_on_call_duty_policies");
    });
  });

  describe("count responses", () => {
    it("unwraps a { count } payload", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.Count),
        { count: 42 },
        {} as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(true);
      expect(result["count"]).toBe(42);
    });
  });

  describe("create responses", () => {
    it("passes the created record through", () => {
      const result: JSONObject = formatToolResponse(
        makeTool(OneUptimeOperation.Create),
        { _id: "new-1" },
        {} as OneUptimeToolCallArgs,
      );

      expect(result["success"]).toBe(true);
      expect(result["operation"]).toBe("create");
      expect((result["data"] as JSONObject)["_id"]).toBe("new-1");
    });
  });
});

describe("truthful pagination and counts", () => {
  it("uses server lookahead and never calls an analytics lower bound an exact total", () => {
    const result: JSONObject = formatToolResponse(
      makeTool(OneUptimeOperation.List),
      {
        data: makeItems(50),
        count: { _type: "PositiveNumber", value: 101 },
        hasMore: true,
      },
      { skip: 50, limit: 50 },
    );
    expect(result["hasMore"]).toBe(true);
    expect(result["totalCount"]).toBeNull();
    expect(result["countLowerBound"]).toBe(101);
    expect(result["nextSkip"]).toBe(100);
  });
  it("honors false lookahead on an exactly full final page", () => {
    const result: JSONObject = formatToolResponse(
      makeTool(OneUptimeOperation.List),
      { data: makeItems(10), count: 20, hasMore: false },
      { skip: 10, limit: 10 },
    );
    expect(result["hasMore"]).toBe(false);
    expect(result["totalCount"]).toBeNull();
    expect(result["countLowerBound"]).toBe(20);
  });
  it("unwraps exact database totals", () => {
    const result: JSONObject = formatToolResponse(
      makeTool(OneUptimeOperation.List),
      { data: makeItems(5), count: { value: 12 } },
      { limit: 5 },
    );
    expect(result["totalCount"]).toBe(12);
    expect(result["hasMore"]).toBe(true);
  });
  it("does not invent zero when a count response is malformed", () => {
    expect(() => {
      return formatToolResponse(
        makeTool(OneUptimeOperation.Count),
        { error: "bad response" },
        {},
      );
    }).toThrow(/count/i);
  });
  it("does not invent an empty list when a list response is malformed", () => {
    expect(() => {
      return formatToolResponse(
        makeTool(OneUptimeOperation.List),
        { error: "bad response" },
        {},
      );
    }).toThrow(/list/i);
  });
});

describe("offset past the last telemetry row", () => {
  it("does not treat an empty page offset as proof of matching rows", () => {
    const result: JSONObject = formatToolResponse(
      makeTool(OneUptimeOperation.List),
      { data: [], count: { value: 100 }, hasMore: false },
      { skip: 100, limit: 10 },
    );
    expect(result["totalCount"]).toBeNull();
    expect(result["countLowerBound"]).toBe(0);
    expect(result["hasMore"]).toBe(false);
    expect(result["message"]).toBe("No Incidents returned at offset 100");
    expect(result["nextSkip"]).toBeUndefined();
  });
});
