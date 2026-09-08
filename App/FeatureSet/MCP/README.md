# OneUptime MCP Server

A Model Context Protocol (MCP) server for investigating requests, services and
releases. This fork defaults to nine read-only tools; the optional advanced
profile exposes 167 tools in the current registry before write-policy filtering.
These capabilities describe this source version. Deploy its App image and
reconnect clients before relying on them; upstream hosted OneUptime may expose a
different catalog.

## How it works

- **Transport**: Streamable HTTP at `/mcp`. The server is **stateless** — no session IDs are issued or required, so it is safe behind load balancers and multi-replica deployments.
- **Hosted endpoint**: `https://oneuptime.com/mcp`
- **Self-hosted endpoint**: `https://<your-host>/mcp` (served by the App container behind Nginx)
- **Auth**: per-request API key via the `x-api-key` header or `Authorization: Bearer <key>` (scheme is case-insensitive). There is no environment-variable API key — every request carries its own key.

## Connecting a client

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oneuptime": {
      "transport": "streamable-http",
      "url": "https://oneuptime.com/mcp",
      "headers": {
        "x-api-key": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http oneuptime https://oneuptime.com/mcp \
  --header "x-api-key: your-api-key-here"
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json` or the user MCP configuration:

```json
{
  "servers": {
    "oneuptime": {
      "type": "http",
      "url": "https://oneuptime.com/mcp",
      "headers": {
        "x-api-key": "${input:oneuptime-api-key}"
      }
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "oneuptime-api-key",
      "description": "OneUptime API Key",
      "password": true
    }
  ]
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "oneuptime": {
      "url": "https://oneuptime.com/mcp",
      "headers": {
        "x-api-key": "your-api-key-here"
      }
    }
  }
}
```

For self-hosted instances, replace `oneuptime.com` with your OneUptime host in any of the above.

## Authentication

Create a **project API key** in OneUptime under **Project Settings → API Keys** and grant it the least privilege the agent needs (read-only keys work for all `get_`/`list_`/`count_` tools). The project is inferred from the key — create tools never need a `projectId` argument.

> **Warning — never give an AI agent a master key.** A OneUptime *master* API key is also accepted on this header and grants instance-wide admin access. Always use a project-scoped API key with least privilege for AI agents.

`oneuptime_help` / `oneuptime_list_resources` work without an API key. Public
status-page tools also need no key when exposed by the advanced profile. All
investigation data calls require the caller's project API key.

## Tool catalog

### Investigation profile (default)

Set `MCP_TOOL_PROFILE=investigation` or leave it unset. Discovery and call
dispatch expose only these nine tools; calling a hidden tool by name is rejected.

| Tool | Result |
|---|---|
| `search_requests` | Observed HTTP requests and logical WebSocket generations, with organization, endpoint, outcome, duration, model, version and trace identity where recorded |
| `get_trace` | Ordered spans with parents/depth, correlated logs, failures, slow operations and coverage gaps |
| `investigate_service` | Whole-window server-operation count, error rate and p95, grouped error operations and example traces |
| `compare_release` | Equal before/after windows around a verified service deployment in one environment and cluster |
| `search_logs` | Compact rows filtered by workload, text, severity and time, with continuation arguments |
| `query_metrics` | A named metric aggregated into time buckets, optionally grouped by up to three attribute keys |
| `oneuptime_whoami` | The OneUptime project identified by the calling API key |
| `oneuptime_help` | Tools and examples for the selected profile |
| `oneuptime_list_resources` | Discovery for the selected profile |

Time filters accept `since: "30m"`, `"2h"`, `"7d"` or an ISO timestamp with a
timezone. `until` defaults to now; the default lookback is one hour and the
maximum window is seven days. Release-marker lookup defaults to 24 hours.
`tts`, `ingress` and `normalizer` resolve known service aliases. Optional
organization and application-project filters require those structured attributes
in the selected telemetry; log text alone is not an indexed identity.

**Requests and traces.** Search resolves the organization's bearing spans first,
then expands their traces so untagged children and parents remain visible. HTTP
requests own their downstream work; WebSocket `tts.turn` generations retain their
own identity separately from the connection. A request spanning multiple services
can match a service/version filter on a child span; its summary describes the
owning request. Organization-filtered results exclude groups bearing conflicting
organization IDs. These are observed telemetry records, not billing totals.

Request pages default to 20 rows (maximum 100), with `skip` up to 1000. Each scan
reads at most 2000 candidate spans, expands at most 100 traces and reads at most
5000 expanded spans. Follow returned `next.arguments` to page the observed
matches with a fixed time window; if `coverage.scanTruncated` is true, narrow the
window. Pagination does not extend the scan. `get_trace` reads at most 2000 spans
and 200 correlated logs inside its requested window. Missing parents, cycles,
truncation, sampling, retention and pending ingestion are coverage limits; no
missing parent does not prove a complete trace. Linked connection traces remain
separate.

**Service statistics.** Counts and p95 aggregate the entire filtered window,
using `SPAN_KIND_SERVER` as the denominator and span error status for errors.
They count server operations, not unique customer requests or WebSocket
generations. Error groups are capped at 200 and example traces at 10; these caps
do not turn the examples into statistical estimates. `no_errors_observed` is not
a guarantee of availability or instrumentation coverage.

**Release comparison.** Require `service`, `environment` and `cluster`.
`windowMinutes` defaults to 30 and accepts 5–360. The lookup uses completed
speech-stack deployment markers and deduplicates `deployment.event_id`; marker
history is capped at 1000 rows and truncation returns `insufficient_data`. Both
windows must have matured, avoid another deployment, and contain at least 30
server operations with complete aggregates. Before includes all observed
versions; after selects the deployed version. A completion marker can follow the
start of traffic shifting or a bake period. Differences are time-correlated
evidence, not proof the deployment caused a regression. Missing markers require
producer activation, not an assumption that no deployments occurred.

**Logs and metrics.** Log pages default to 20, maximum 100, with `skip` up to
100000; use `next.arguments` to preserve the time window. Bodies are capped at
2000 characters with `bodyTruncated`. Stored severity can reflect stderr
fallback. Metrics retain native units and support Count/Avg/Sum/Min/Max and
P50/P90/P95/P99 across minute through day buckets or the total window; aggregate
output is capped at 200 rows with explicit truncation. `Count` counts telemetry
points, missing data is not zero, and cumulative counters need rate-aware
interpretation.

### Advanced profile

Set `MCP_TOOL_PROFILE=advanced` to include the investigation tools plus the
generated database CRUD tools, telemetry `list_`/`count_` tools, public status-page
tools and incident/alert acknowledgement, resolution and note workflows. Inspect
`oneuptime_help` or `/mcp/tools` for the exact current registry; model additions
can change its size. `MCP_READ_ONLY=true` removes mutations and
`MCP_ALLOW_DESTRUCTIVE=false` removes destructive tools. These are server-side
filters; every remaining call still uses the caller's API-key permissions.

Generated CRUD resources include incidents, alerts, monitors, their state and
severity records, teams and status pages. Telemetry includes spans, logs, metrics,
exception instances, monitor logs and change events. Advanced mutation workflows
include `acknowledge_incident`, `resolve_incident`, `acknowledge_alert`,
`resolve_alert`, `add_incident_note` and `add_alert_note`; public notes can appear
on status pages.

### Annotations and results

All tools carry MCP annotations and titles: `readOnlyHint` on every `get_`/`list_`/`count_` tool and `destructiveHint` on every `delete_` tool, so clients can auto-approve safe calls and confirm destructive ones. Tool results include `structuredContent` alongside the JSON text. Errors come back as in-band tool results (`isError: true`) with `statusCode`, `details`, and a `suggestion` — not as protocol errors.

## Query, sort, select, and pagination

### Queries

Query fields accept a direct value or an operator object:

```json
{
  "query": {
    "title": { "_type": "Search", "value": "database" },
    "createdAt": { "_type": "GreaterThan", "value": "2026-07-01T00:00:00.000Z" }
  }
}
```

Operators: `EqualTo`, `NotEqual`, `IsNull`, `NotNull`, `EqualToOrNull`, `GreaterThan`, `LessThan`, `GreaterThanOrEqual`, `LessThanOrEqual`, `InBetween`, `Search`, `Includes`.

### Sort

```json
{ "sort": { "createdAt": "DESC" } }
```

Values are `"ASC"` or `"DESC"`.

### Select

`get_` and `list_` tools take an optional `select` array of field names. By default all readable fields are returned **except** heavy ones (JSON / VeryLongText / HTML columns), which must be requested explicitly.

### Pagination

For advanced generated list tools, `limit` defaults to 10 (max 100) and `skip`
offsets into the result set. The adapter passes pagination in the REST query
string. Analytics list counts are lower bounds: `totalCount` is `null`,
`countLowerBound` carries the observed lower bound and `hasMore` carries the API's lookahead result.
Use a corresponding `count_*` call when an exact total is required. For example:

```json
{
  "returnedCount": 10,
  "totalCount": null,
  "countLowerBound": 11,
  "skip": 0,
  "limit": 10,
  "hasMore": true,
  "data": ["..."]
}
```

## Example investigation

Call `search_requests` with:

```json
{"organization":"13","since":"2h","status":"error","limit":20}
```

Then call `get_trace` with a returned `traceId` and the exact `since`/`until`
from the search response's scope. A service overview uses:

```json
{"service":"tts","environment":"production","cluster":"kugel-eu-prod","since":"30m"}
```

Pass that object to `investigate_service`. To compare the latest matching
verified release, call `compare_release` with the same service/environment/cluster
and `windowMinutes: 30`; omit `since` to use the 24-hour marker lookup.

## HTTP endpoints

| Endpoint      | Method | Behavior                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------ |
| `/mcp`        | POST   | JSON-RPC (tool calls and all MCP operations)                              |
| `/mcp`        | GET    | Without an SSE `Accept` header: friendly JSON discovery payload. With one: `405` (no standalone SSE stream in stateless mode). |
| `/mcp`        | DELETE | No-op (stateless — nothing to terminate)                                  |
| `/mcp/tools`  | GET    | REST listing of available tools                                           |
| `/mcp/health` | GET    | Health check                                                              |

## Self-hosting

The MCP server ships as part of the App container and is served at `/mcp` behind Nginx — no separate deployment is needed. The OneUptime API URL it talks to is derived from the `HOST` and `HTTP_PROTOCOL` environment variables via `Common/Server/EnvironmentConfig` (inherited from the App service's environment). API keys are never configured on the server; clients supply them per request.

Organization filters accept the positive numeric application organization ID as a
string, for example `"organization": "13"`. The MCP queries the stored
`organization.id` attribute directly; names and public IDs are rejected.
The KugelAudio monorepo owns the release-event producer and deployment
configuration under `packages/private/ci/release/` and `infrastructure/oneuptime/`.

## Development

The MCP server lives in `App/FeatureSet/MCP` and is mounted into the App service at startup (`App/Index.ts`). Tests live in `App/FeatureSet/MCP/Tests` and run as part of the App test suite:

```bash
cd App
npm install
npx jest ./FeatureSet/MCP/Tests --runInBand
```

New models are picked up automatically: decorate a database model with `@EnableMCP` (or set `enableMCP` on an analytics model) and the tool generator creates its tools on the next start.

## License

Apache-2.0 - See LICENSE file for details.
