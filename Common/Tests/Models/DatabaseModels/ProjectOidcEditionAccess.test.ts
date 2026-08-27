import ProjectOIDC from "../../../Models/DatabaseModels/ProjectOidc";
import ProjectSSO from "../../../Models/DatabaseModels/ProjectSso";
import { describe, expect, test } from "@jest/globals";

describe("Project OIDC edition access", () => {
  test("KugelAudio Community builds expose OIDC without opening SAML", () => {
    expect(new ProjectOIDC().requiresEnterprise).toBe(false);
    expect(new ProjectSSO().requiresEnterprise).toBe(true);
  });
});
