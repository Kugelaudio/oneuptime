import { generateAllTools } from "../Tools/ToolGenerator";
import { registerToolHandlers, ToolCallResult } from "../Handlers/ToolHandler";
import { handleHelperTool } from "../Tools/HelperTools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpToolInfo } from "../Types/McpTypes";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
it("defaults to nine compact read-only tools; advanced keeps the generated catalog", () => {
  const tools: McpToolInfo[] = generateAllTools("investigation");
  expect(
    tools
      .map((t: McpToolInfo) => {
        return t.name;
      })
      .sort(),
  ).toEqual(
    [
      "search_requests",
      "get_trace",
      "investigate_service",
      "compare_release",
      "search_logs",
      "query_metrics",
      "oneuptime_help",
      "oneuptime_list_resources",
      "oneuptime_whoami",
    ].sort(),
  );
  expect(
    tools.every((t: McpToolInfo) => {
      return t.annotations?.readOnlyHint;
    }),
  ).toBe(true);
  expect(
    generateAllTools("advanced").some((t: McpToolInfo) => {
      return t.name === "list_spans";
    }),
  ).toBe(true);
  expect(() => {
    return generateAllTools("typo");
  }).toThrow("MCP_TOOL_PROFILE");
});
it("cannot call a hidden workflow by bypassing discovery", async () => {
  const register: jest.Mock = jest.fn();
  registerToolHandlers(
    { server: { setRequestHandler: register } } as unknown as McpServer,
    [],
    "viewer",
  );
  const call: (request: CallToolRequest) => Promise<ToolCallResult> =
    register.mock.calls[1]![1];
  await expect(
    call({
      method: "tools/call",
      params: {
        name: "resolve_incident",
        arguments: { incidentId: "550e8400-e29b-41d4-a716-446655440000" },
      },
    }),
  ).rejects.toThrow("disabled tool");
});
it("lists real tool names and examples for the selected profile", () => {
  const tools: McpToolInfo[] = generateAllTools("investigation");
  const result: {
    profile: string;
    examples: { customerFailures: { tool: string } };
    tools: { name: string }[];
  } = JSON.parse(
    handleHelperTool("oneuptime_help", { topic: "examples" }, tools),
  );
  expect(result.profile).toBe("investigation");
  expect(result.examples.customerFailures.tool).toBe("search_requests");
  expect(
    result.tools.some((t: { name: string }) => {
      return t.name === "list_spans";
    }),
  ).toBe(false);
});
