/**
 * OneUptimeApiService behavior tests.
 *
 * Covers the request-building and resilience behavior around executeOperation:
 * - missing/undefined args are normalized to {} (parameterless list calls work)
 * - non-UUID ids are rejected before any HTTP request is attempted
 * - select accepts an array of field names (converted to { field: true })
 * - select-permission errors drop the denied column and retry
 * - OneUptimeApiError carries statusCode and details
 *
 * The HTTP layer is mocked by spying on the private static makeApiRequest,
 * so no network traffic occurs.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

jest.mock("../Utils/MCPLogger");

import OneUptimeApiService, {
  OneUptimeApiError,
} from "../Services/OneUptimeApiService";
import OneUptimeOperation from "../Types/OneUptimeOperation";
import ModelType from "../Types/ModelType";
import { OneUptimeToolCallArgs } from "../Types/McpTypes";
import { JSONObject, JSONValue } from "Common/Types/JSON";
import API from "Common/Utils/API";
import HTTPResponse from "Common/Types/API/HTTPResponse";
import { SpyInstance } from "jest-mock";
import Route from "Common/Types/API/Route";
import Headers from "Common/Types/API/Headers";

const VALID_UUID: string = "550e8400-e29b-41d4-a716-446655440000";
const API_KEY: string = "test-api-key";

type PostApiCall = (
  ...args: Parameters<typeof API.post>
) => ReturnType<typeof API.post>;

type MakeApiRequestArgs = [
  OneUptimeOperation,
  Route,
  Headers,
  JSONObject | undefined,
];

describe("OneUptimeApiService behavior", () => {
  // Bare SpyInstance keeps the annotation compatible across @types/jest versions
  let makeApiRequestSpy: jest.SpyInstance;

  beforeAll(() => {
    OneUptimeApiService.initialize({ url: "https://test.oneuptime.com" });
  });

  beforeEach(() => {
    makeApiRequestSpy = jest
      .spyOn(
        OneUptimeApiService as unknown as {
          makeApiRequest: (...args: MakeApiRequestArgs) => Promise<unknown>;
        },
        "makeApiRequest",
      )
      .mockResolvedValue({ data: [], count: 0 }) as unknown as jest.SpyInstance;
  });

  afterEach(() => {
    makeApiRequestSpy.mockRestore();
  });

  describe("argument normalization", () => {
    it("treats undefined args as {} for list operations", async () => {
      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.List,
          ModelType.Database,
          "/incident",
          undefined as unknown as OneUptimeToolCallArgs,
          API_KEY,
        ),
      ).resolves.toEqual({ data: [], count: 0 });

      expect(makeApiRequestSpy).toHaveBeenCalledTimes(1);
      const requestData: JSONObject | undefined =
        makeApiRequestSpy.mock.calls[0]?.[3];
      expect(requestData?.["query"]).toEqual({});
    });

    it("treats null args as {} for count operations", async () => {
      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.Count,
          ModelType.Database,
          "/incident",
          null as unknown as OneUptimeToolCallArgs,
          API_KEY,
        ),
      ).resolves.toBeDefined();

      expect(makeApiRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("id validation", () => {
    it("rejects a non-UUID id with a friendly error before any HTTP call", async () => {
      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.Read,
          ModelType.Database,
          "/incident",
          { id: "abc" },
          API_KEY,
        ),
      ).rejects.toThrow(/UUID/);

      expect(makeApiRequestSpy).not.toHaveBeenCalled();
    });

    it("accepts a valid UUID id and routes to get-item", async () => {
      makeApiRequestSpy.mockResolvedValue({ _id: VALID_UUID });

      await OneUptimeApiService.executeOperation(
        "Incident",
        OneUptimeOperation.Read,
        ModelType.Database,
        "/incident",
        { id: VALID_UUID },
        API_KEY,
      );

      const route: Route | undefined = makeApiRequestSpy.mock.calls[0]?.[1];
      expect(route?.toString()).toContain(`/${VALID_UUID}/get-item`);
    });
  });

  describe("select handling", () => {
    it("converts an array select into a { field: true } object", async () => {
      await OneUptimeApiService.executeOperation(
        "Incident",
        OneUptimeOperation.List,
        ModelType.Database,
        "/incident",
        { select: ["_id", "title"] },
        API_KEY,
      );

      const requestData: JSONObject | undefined =
        makeApiRequestSpy.mock.calls[0]?.[3];
      expect(requestData?.["select"]).toEqual({ _id: true, title: true });
    });

    it("falls back to the generated select for an empty array", async () => {
      await OneUptimeApiService.executeOperation(
        "Incident",
        OneUptimeOperation.List,
        ModelType.Database,
        "/incident",
        { select: [] },
        API_KEY,
      );

      const requestData: JSONObject | undefined =
        makeApiRequestSpy.mock.calls[0]?.[3];
      const select: JSONObject = requestData?.["select"] as JSONObject;
      expect(Object.keys(select).length).toBeGreaterThan(0);
    });

    it("drops a column named in a select-permission error and retries", async () => {
      makeApiRequestSpy
        .mockRejectedValueOnce(
          new OneUptimeApiError(
            "API request failed: 403 - You do not have permissions to select on - internalNote.",
            403,
          ),
        )
        .mockResolvedValueOnce({ data: [], count: 0 });

      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.List,
          ModelType.Database,
          "/incident",
          { select: ["_id", "internalNote"] },
          API_KEY,
        ),
      ).resolves.toEqual({ data: [], count: 0 });

      expect(makeApiRequestSpy).toHaveBeenCalledTimes(2);
      const retryData: JSONObject | undefined =
        makeApiRequestSpy.mock.calls[1]?.[3];
      const retrySelect: JSONObject = retryData?.["select"] as JSONObject;
      expect(retrySelect).toEqual({ _id: true });
      expect("internalNote" in retrySelect).toBe(false);
    });

    it("does not retry errors that are not select-permission failures", async () => {
      makeApiRequestSpy.mockRejectedValue(
        new OneUptimeApiError("API request failed: 500 - boom", 500),
      );

      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.List,
          ModelType.Database,
          "/incident",
          { select: ["_id"] },
          API_KEY,
        ),
      ).rejects.toThrow(/boom/);

      expect(makeApiRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("API key validation", () => {
    it("rejects operations without an API key", async () => {
      await expect(
        OneUptimeApiService.executeOperation(
          "Incident",
          OneUptimeOperation.List,
          ModelType.Database,
          "/incident",
          {},
          "",
        ),
      ).rejects.toThrow(/API key is required/);

      expect(makeApiRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe("OneUptimeApiError", () => {
    it("carries statusCode and details", () => {
      const error: OneUptimeApiError = new OneUptimeApiError(
        "API request failed: 403 - Forbidden",
        403,
        { field: "internalNote" },
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("OneUptimeApiError");
      expect(error.statusCode).toBe(403);
      expect(error.details).toEqual({ field: "internalNote" });
    });
  });
});

describe("HTTP pagination contract", () => {
  it("sends explicit page sizes and offsets in the URL, with bounded HTTP options", async () => {
    const post: SpyInstance<PostApiCall> = jest
      .spyOn(API, "post")
      .mockResolvedValue({
        data: { data: [], count: 0, hasMore: false },
      } as any);
    try {
      OneUptimeApiService.initialize({ url: "https://test.oneuptime.com" });
      await OneUptimeApiService.executeOperation(
        "Log",
        OneUptimeOperation.List,
        ModelType.Analytics,
        "/log",
        { skip: 50, limit: 50, select: ["time"] },
        API_KEY,
      );
      expect(post.mock.calls[0]?.[0].url.getQueryParam("skip")).toBe("50");
      expect(post.mock.calls[0]?.[0].url.getQueryParam("limit")).toBe("50");
      expect(post.mock.calls[0]?.[0].options).toMatchObject({
        timeout: 30000,
        retries: 0,
      });
    } finally {
      post.mockRestore();
    }
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity])(
    "rejects an invalid limit (%s) before HTTP",
    async (limit: number) => {
      const post: SpyInstance<PostApiCall> = jest
        .spyOn(API, "post")
        .mockResolvedValue({ data: {} } as any);
      try {
        await expect(
          OneUptimeApiService.executeOperation(
            "Log",
            OneUptimeOperation.List,
            ModelType.Analytics,
            "/log",
            { limit },
            API_KEY,
          ),
        ).rejects.toThrow(/limit/);
        expect(post).not.toHaveBeenCalled();
      } finally {
        post.mockRestore();
      }
    },
  );
});

describe("authenticated composite-tool HTTP calls", () => {
  it("preserves an embedded querystring and bounds the call duration", async () => {
    const post: SpyInstance<PostApiCall> = jest
      .spyOn(API, "post")
      .mockResolvedValue({ data: { data: [] } } as any);
    try {
      OneUptimeApiService.initialize({ url: "https://test.oneuptime.com" });
      await OneUptimeApiService.makeAuthenticatedApiCall({
        method: "POST",
        path: "/api/span/get-list?skip=100&limit=100",
        body: { query: {} },
        apiKey: API_KEY,
      });
      expect(post.mock.calls[0]?.[0].url.toString()).toBe(
        "https://test.oneuptime.com/api/span/get-list?skip=100&limit=100",
      );
      expect(post.mock.calls[0]?.[0].url.getQueryParam("skip")).toBe("100");
      expect(post.mock.calls[0]?.[0].options).toMatchObject({
        timeout: 30000,
        retries: 0,
      });
    } finally {
      post.mockRestore();
    }
  });
});

it("retains pagination metadata through the real HTTPResponse unwrapping boundary", async () => {
  const response: HTTPResponse<JSONObject> = new HTTPResponse(
    200,
    {
      data: [
        { time: { _type: "DateTime", value: "2026-09-08T12:00:00.000Z" } },
      ],
      count: { _type: "PositiveNumber", value: 2 },
      skip: 0,
      limit: 1,
      hasMore: true,
    },
    {},
  );
  const post: SpyInstance<PostApiCall> = jest
    .spyOn(API, "post")
    .mockResolvedValue(response as any);
  try {
    OneUptimeApiService.initialize({ url: "https://test.oneuptime.com" });
    const result: JSONValue =
      await OneUptimeApiService.makeAuthenticatedApiCall({
        method: "POST",
        path: "/api/logs/get-list?limit=1",
        apiKey: API_KEY,
      });
    expect(result).toMatchObject({
      data: [
        { time: { _type: "DateTime", value: "2026-09-08T12:00:00.000Z" } },
      ],
      hasMore: true,
      limit: 1,
      skip: 0,
    });
    const generated: JSONValue = await OneUptimeApiService.executeOperation(
      "Log",
      OneUptimeOperation.List,
      ModelType.Analytics,
      "/logs",
      { limit: 1, select: ["time"] },
      API_KEY,
    );
    expect(generated).toEqual(result);
  } finally {
    post.mockRestore();
  }
});
