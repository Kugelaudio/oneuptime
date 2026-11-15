import DatabaseService from "../../../Server/Services/DatabaseService";
import HTTPErrorResponse from "../../../Types/API/HTTPErrorResponse";
import HTTPResponse from "../../../Types/API/HTTPResponse";
import Protocol from "../../../Types/API/Protocol";
import Route from "../../../Types/API/Route";
import URL from "../../../Types/API/URL";
import { JSONObject } from "../../../Types/JSON";
import Sleep from "../../../Types/Sleep";
import API from "../../../Utils/API";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import axios, {
  AxiosError,
  AxiosHeaders,
  AxiosResponse,
  AxiosStatic,
} from "axios";

jest.mock("axios", () => {
  // Keep the real helpers (axios.isAxiosError) and mock only the callable.
  return Object.assign(jest.fn(), jest.requireActual("axios"));
});

const mockedAxios: jest.MockedFunction<AxiosStatic> =
  axios as unknown as jest.MockedFunction<AxiosStatic>;

/*
 * Kugelaudio fork (#25, review of the 14.0.110 port): the workflow trigger is
 * not idempotent. The worker answers "Triggered" before it starts the runs, so
 * a POST it accepted whose answer was lost on the way back has already started
 * every workflow; sending it again would run them twice. Only failures the
 * worker cannot have acted on are retried: a connection that never opened, or
 * an error it answered with.
 */
function transportError(data: {
  code?: string | undefined;
  status?: number | undefined;
}): AxiosError {
  const error: AxiosError = new Error("request failed") as AxiosError;
  error.isAxiosError = true;
  error.name = "AxiosError";
  error.config = { headers: new AxiosHeaders() };
  error.toJSON = () => {
    return {};
  };
  if (data.code) {
    error.code = data.code;
  }
  if (data.status !== undefined) {
    error.response = {
      status: data.status,
      statusText: "",
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    } as unknown as AxiosResponse;
  }
  return error;
}

function triggered(): AxiosResponse {
  return {
    data: { status: "Triggered" },
    status: 200,
    statusText: "OK",
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as unknown as AxiosResponse;
}

async function sendTrigger(): Promise<
  HTTPResponse<JSONObject> | HTTPErrorResponse
> {
  return API.post<JSONObject>({
    url: new URL(
      Protocol.HTTP,
      "workflow",
      new Route("/workflow/model/project/alert/on-create"),
    ),
    data: { data: { _id: "alert" } },
    options: DatabaseService.WORKFLOW_TRIGGER_REQUEST_OPTIONS,
  });
}

beforeEach(() => {
  jest.spyOn(Sleep, "sleep").mockImplementation(async () => {});
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  mockedAxios.mockReset();
  jest.restoreAllMocks();
});

describe("the workflow trigger after an accepted request whose response was lost", () => {
  test.each(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"])(
    "is sent once when the answer never came (%s)",
    async (code: string) => {
      mockedAxios
        .mockRejectedValueOnce(transportError({ code }))
        .mockResolvedValueOnce(triggered());

      await sendTrigger().catch(() => {
        return undefined;
      });

      expect(mockedAxios).toHaveBeenCalledTimes(1);
    },
  );
});

describe("the workflow trigger when the worker cannot have acted on it", () => {
  test.each([
    { name: "refused connection (worker restarting)", code: "ECONNREFUSED" },
    { name: "unresolved host", code: "ENOTFOUND" },
    { name: "a 503 the worker answered", status: 503 },
    { name: "a 500 the worker answered", status: 500 },
  ])("is sent again after a $name", async (failure: {
    name: string;
    code?: string | undefined;
    status?: number | undefined;
  }) => {
    mockedAxios
      .mockRejectedValueOnce(
        transportError({ code: failure.code, status: failure.status }),
      )
      .mockResolvedValueOnce(triggered());

    const response: HTTPResponse<JSONObject> | HTTPErrorResponse =
      await sendTrigger();

    expect(mockedAxios).toHaveBeenCalledTimes(2);
    expect(response).toBeInstanceOf(HTTPResponse);
  });

  test("a 4xx is the request itself being wrong and is not sent again", async () => {
    mockedAxios
      .mockRejectedValueOnce(transportError({ status: 400 }))
      .mockResolvedValueOnce(triggered());

    await sendTrigger().catch(() => {
      return undefined;
    });

    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });
});

describe("DatabaseService.isWorkflowTriggerUndelivered", () => {
  test("reads a response or a never-connected code, nothing else", () => {
    expect(
      DatabaseService.isWorkflowTriggerUndelivered(
        transportError({ code: "ECONNREFUSED" }),
      ),
    ).toBe(true);
    expect(
      DatabaseService.isWorkflowTriggerUndelivered(
        transportError({ code: "ECONNRESET" }),
      ),
    ).toBe(false);
    expect(DatabaseService.isWorkflowTriggerUndelivered(new Error("x"))).toBe(
      false,
    );
    expect(DatabaseService.isWorkflowTriggerUndelivered(undefined)).toBe(false);
  });
});
