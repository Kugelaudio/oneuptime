import DatabaseService from "../../../Server/Services/DatabaseService";
import Alert from "../../../Models/DatabaseModels/Alert";
import ObjectID from "../../../Types/ObjectID";
import API, { APIRequestOptions } from "../../../Utils/API";
import { getJestSpyOn } from "../../Spy";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

/*
 * The workflow trigger is one fire-and-forget POST to the worker, and nothing
 * re-sends it. On 2026-10-06 the workers restarted after a Redis stall and 8
 * of 26 alert on-create triggers were lost, so their Slack and paging
 * workflows never ran. The trigger now carries a retry budget that outlasts a
 * worker rollout; this pins it, because dropping the options compiles fine and
 * fails nothing until the next restart loses a page.
 */
describe("DatabaseService.onTriggerWorkflow", () => {
  let postSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    postSpy = getJestSpyOn(API, "post").mockResolvedValue({} as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("retries the trigger for up to five minutes, on retryable failures only", async () => {
    const service: DatabaseService<Alert> = new DatabaseService<Alert>(Alert);

    await service.onTriggerWorkflow(
      ObjectID.generate(),
      ObjectID.generate(),
      "on-create",
    );

    expect(postSpy).toHaveBeenCalledTimes(1);
    const request: APIRequestOptions = postSpy.mock
      .calls[0]![0] as APIRequestOptions;
    expect(request.url.toString()).toContain("/alert/on-create");
    expect(request.options).toEqual({
      retries: 8,
      exponentialBackoff: true,
      maxBackoffInMs: 30000,
      totalTimeoutInMs: 300000,
      retryOnlyOnRetryableErrors: true,
    });
  });
});
