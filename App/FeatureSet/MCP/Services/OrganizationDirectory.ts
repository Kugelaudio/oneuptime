import { readFileSync } from "fs";
import OneUptimeApiService from "./OneUptimeApiService";

interface OrganizationEntry {
  id: string;
  name: string;
  publicId?: string;
}
interface OrganizationDirectory {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  organizations: OrganizationEntry[];
}
const ORGANIZATION_ID: RegExp = /^[1-9]\d*$/;
const MAX_DIRECTORY_AGE_MS: number = 7 * 24 * 60 * 60 * 1000;

/** Resolve application identities, never fuzzy-match an organization from traffic. */
export async function resolveOrganization(
  value: string,
  apiKey: string,
): Promise<string> {
  const identity: string = value.trim();
  if (ORGANIZATION_ID.test(identity)) {
    return identity;
  }
  if (!identity) {
    throw new Error("Organization must be a non-empty name or ID.");
  }
  const filename: string | undefined =
    process.env["MCP_ORGANIZATION_DIRECTORY_FILE"];
  if (!filename) {
    throw new Error(
      "Organization names require MCP_ORGANIZATION_DIRECTORY_FILE exported from application data; supply the numeric organization ID meanwhile.",
    );
  }
  const directory: OrganizationDirectory = parseDirectory(
    readFileSync(filename, "utf8"),
  );
  /*
   * Authenticate the calling key before revealing any directory match. No global
   * identity cache: project A must never reuse project B's directory lookup.
   */
  const result: unknown = await OneUptimeApiService.makeAuthenticatedApiCall({
    method: "POST",
    path: "/api/project/get-list?skip=0&limit=2",
    apiKey,
    body: { query: {}, select: { _id: true }, limit: 2, skip: 0 },
  });
  const rows: unknown = (result as { data?: unknown })?.data;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(
      "Organization resolution requires a key scoped to exactly one OneUptime project.",
    );
  }
  const rawId: unknown = (rows[0] as { _id?: unknown })._id;
  const projectId: unknown =
    typeof rawId === "object" && rawId !== null
      ? (rawId as { value?: unknown }).value
      : rawId;
  if (projectId !== directory.projectId) {
    throw new Error(
      "Organization directory belongs to a different OneUptime project.",
    );
  }
  const matches: OrganizationEntry[] = directory.organizations.filter(
    (entry: OrganizationEntry) => {
      return (
        entry.name.toLocaleLowerCase("en-US") ===
          identity.toLocaleLowerCase("en-US") || entry.publicId === identity
      );
    },
  );
  if (!matches.length) {
    throw new Error(
      "Organization not found in the application directory; use an exact name or numeric ID.",
    );
  }
  if (matches.length !== 1) {
    throw new Error("Organization name is ambiguous; use its numeric ID.");
  }
  return matches[0]!.id;
}

function parseDirectory(raw: string): OrganizationDirectory {
  if (Buffer.byteLength(raw) > 5_000_000) {
    throw new Error("Organization directory exceeds 5 MB.");
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") {
    throw new Error("Invalid organization directory.");
  }
  const directory: Partial<OrganizationDirectory> = value;
  if (
    directory.schemaVersion !== 1 ||
    typeof directory.projectId !== "string" ||
    typeof directory.generatedAt !== "string" ||
    !Array.isArray(directory.organizations)
  ) {
    throw new Error("Invalid organization directory schema.");
  }
  const age: number = Date.now() - Date.parse(directory.generatedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MAX_DIRECTORY_AGE_MS) {
    throw new Error(
      "Organization directory is stale or has an invalid generation time; refresh the application export or use a numeric ID.",
    );
  }
  const ids: Set<string> = new Set();
  for (const entry of directory.organizations) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !ORGANIZATION_ID.test(entry.id) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      (entry.publicId !== undefined && typeof entry.publicId !== "string") ||
      ids.has(entry.id)
    ) {
      throw new Error(
        "Invalid or duplicate identity in organization directory.",
      );
    }
    ids.add(entry.id);
  }
  return directory as OrganizationDirectory;
}
