import { resolveOrganization } from "../Services/OrganizationDirectory";
import OneUptimeApiService from "../Services/OneUptimeApiService";
import { readFileSync } from "fs";

jest.mock("fs", () => {
  return {
    ...jest.requireActual("fs"),
    readFileSync: jest.fn(),
  };
});
jest.mock("../Services/OneUptimeApiService");
const read: jest.Mock = readFileSync as jest.Mock;
const call: jest.Mock =
  OneUptimeApiService.makeAuthenticatedApiCall as jest.Mock;
const projectId: string = "956e51cb-d8d4-43e8-87ca-a59ce138f133";
beforeEach(() => {
  jest.clearAllMocks();
  process.env["MCP_ORGANIZATION_DIRECTORY_FILE"] = "/configured/directory.json";
  call.mockResolvedValue({ data: [{ _id: projectId }] });
  read.mockReturnValue(
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      generatedAt: new Date().toISOString(),
      organizations: [
        { id: "13", name: "Acme", publicId: "org-acme" },
        { id: "14", name: "Other" },
      ],
    }),
  );
});
afterEach(() => {
  delete process.env["MCP_ORGANIZATION_DIRECTORY_FILE"];
});
it("accepts explicit internal IDs without a directory lookup", async () => {
  expect(await resolveOrganization("13", "viewer")).toBe("13");
  expect(call).not.toHaveBeenCalled();
});
it("resolves exact names and public IDs in the authenticated project", async () => {
  expect(await resolveOrganization("acme", "viewer")).toBe("13");
  expect(await resolveOrganization("org-acme", "viewer")).toBe("13");
  expect(call.mock.calls[0][0].apiKey).toBe("viewer");
});
it("never uses a directory belonging to a different OneUptime project", async () => {
  call.mockResolvedValue({ data: [{ _id: "other-project" }] });
  await expect(resolveOrganization("Acme", "viewer")).rejects.toThrow(
    /project/i,
  );
});
it("rejects missing, ambiguous, malformed and stale identities", async () => {
  await expect(resolveOrganization("Ac", "viewer")).rejects.toThrow(
    /not found/i,
  );
  read.mockReturnValue(
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      generatedAt: new Date().toISOString(),
      organizations: [
        { id: "13", name: "Acme" },
        { id: "14", name: "Acme" },
      ],
    }),
  );
  await expect(resolveOrganization("Acme", "viewer")).rejects.toThrow(
    /ambiguous/i,
  );
  read.mockReturnValue("{}");
  await expect(resolveOrganization("Acme", "viewer")).rejects.toThrow(
    /directory/i,
  );
  read.mockReturnValue(
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      generatedAt: "2020-01-01T00:00:00Z",
      organizations: [],
    }),
  );
  await expect(resolveOrganization("Acme", "viewer")).rejects.toThrow(/stale/i);
});
it("explains configuration absence without broadening the search", async () => {
  delete process.env["MCP_ORGANIZATION_DIRECTORY_FILE"];
  await expect(resolveOrganization("Acme", "viewer")).rejects.toThrow(
    /MCP_ORGANIZATION_DIRECTORY_FILE/,
  );
});
