# OneUptime MCP Server

A Model Context Protocol (MCP) server for investigating requests, services and
releases. This fork defaults to nine read-only tools; the optional advanced
profile exposes upstream's full generated catalog (about 290 tools) before write-policy filtering.
These capabilities describe this source version. Deploy its App image and
reconnect clients before relying on them; upstream hosted OneUptime may expose a
different catalog.

## How it works

- **Transport**: Streamable HTTP at `/mcp`. The server is **stateless** — no session IDs are issued or required, so it is safe behind load balancers and multi-replica deployments.
- **Hosted endpoint**: `https://oneuptime.com/mcp`
- **Self-hosted endpoint**: `https://<your-host>/mcp` (served by the App container behind Nginx)
- **Auth**: sign in with OneUptime (OAuth 2.1, per the MCP authorization specification), or a per-request API key via the `x-api-key` header or `Authorization: Bearer <key>` (scheme is case-insensitive). There is no environment-variable API key — every request carries its own credential.

## Connecting a client

### By signing in

Give the client the URL and nothing else. The first call to a tool that needs an identity is answered `401` with a `WWW-Authenticate` challenge; the client discovers the authorization server from it, opens the consent screen in the user's browser, and gets tokens for the project the user picks.

```bash
claude mcp add --transport http oneuptime https://oneuptime.com/mcp
```

```json
{ "servers": { "oneuptime": { "type": "http", "url": "https://oneuptime.com/mcp" } } }
```

The rest of this section configures the same clients with an API key instead, for agents that run unattended.

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

### API key

Create a **project API key** in OneUptime under **Project Settings → Advanced → API Keys** and grant it the least privilege the agent needs (read-only keys work for all `get_`/`list_`/`count_` tools). The project is inferred from the key — create tools never need a `projectId` argument.

> **Warning — never give an AI agent a master key.** A OneUptime *master* API key is also accepted on this header and grants instance-wide admin access. Always use a project-scoped API key with least privilege for AI agents.

Public status page tools and `oneuptime_help` / `oneuptime_list_resources` / `oneuptime_describe_resource` work without any credential.

### OAuth sign-in

The code is in `OAuth/`; each file opens with the reasoning behind it. The shape of it:

- **One issuer under `/mcp`.** `https://<host>/mcp` is both the protected resource (RFC 9728) and the authorization server's issuer (RFC 8414). Every endpoint sits under `/mcp/oauth`, and every URL is built from `HOST` / `HTTP_PROTOCOL`, never from the request.
- **Lazy, at the HTTP layer.** `OAuth/RequestGate` runs before the MCP SDK sees a request. `initialize`, `tools/list` and the public tools pass with no credential; a call to a tool that needs an identity is refused `401` (or `403 insufficient_scope` for a read-only grant calling a write tool) with a Bearer challenge. It cannot live in a tool handler: a refusal from inside the SDK is a `200`, and a client only starts signing its user in on a real `401`.
- **Clients identify themselves.** A Client ID Metadata Document (`OAuth/ClientIdMetadataDocument`, fetched through the egress guard with private addresses always blocked) or Dynamic Client Registration (`OAuth/RegistrationEndpoint`). Nobody registers a client by hand.
- **Authorization code + PKCE (S256 only)**, resource indicators (RFC 8707), `iss` in the authorization response (RFC 9207), rotating refresh tokens with reuse detection, revocation (RFC 7009).
- **Opaque tokens, stored as hashes.** `oumcp_ac_…` / `oumcp_at_…` / `oumcp_rt_…`; only the SHA-256 is kept (`McpOAuthToken`). A grant (`McpOAuthGrant`) is one member letting one client act for them in one project; revoking is deleting the grant, which cascades to its tokens.
- **Only an access token is a credential.** `x-api-key` carries an API key and nothing else; `Authorization` carries an API key or an access token. Any other `oumcp_` secret presented in either header — a refresh token, a code, a client secret, or an access token in `x-api-key` — is refused `401 invalid_token` by `OAuth/RequestGate` and is never passed on to the API as an API key.
- **Scopes** `mcp:read` and `mcp:write` (write includes read). The consent screen can narrow what a client asked for, never widen it.
- **The API never sees the client's token.** Having accepted an access token, the MCP layer calls the REST API with a 60-second signed *delegation token* (`Common/Server/Utils/Mcp/McpDelegationToken`). `Common/Server/Middleware/McpDelegationAuthorization` turns that into a request authorized as the member — never as a master admin — in the grant's project, with their live permissions, and marked read-only when the grant is. A stolen access token is therefore worth exactly what the MCP tools can do with it.
- **Checked on every use.** `Common/Server/Utils/Mcp/McpOAuthGrantAccess` re-evaluates the grant per request and per token exchange: the member still exists, is not blocked, still belongs to the project, is not on a team that blocks `AuthorizeMcpClient`, and still satisfies the project's SSO requirement.
- **Consent** is the Accounts page `/accounts/mcp-authorize`; **managing connected clients** is Settings → MCP Server in the Dashboard.

Two settings: `DISABLE_MCP_OAUTH=true` switches the whole thing off (the routes answer 404 and an unauthenticated tool call gets the in-band "API key is required" result it always got), and `DISABLE_MCP_OAUTH_CLIENT_ID_METADATA_DOCUMENTS=true` is for instances that cannot make outbound requests.

In the default investigation profile, every investigation data call needs the caller's project API key or OAuth sign-in.

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

#### Generated catalog (advanced profile)

Each of these 27 models gets six tools: `create_`, `get_`, `list_`, `update_`, `delete_`, `count_` (e.g. `create_incident`, `get_incident`, `list_incidents`, `update_incident`, `delete_incident`, `count_incidents`):

Incident, Alert, Incident Alert, Monitor, Status Page, Scheduled Maintenance Event, Team, Monitor Status, On-Call Policy, Incident State, Incident Severity, Alert State, Alert Severity, Incident State Timeline, Alert State Timeline, Incident Public Note, Incident Internal Note, Alert Internal Note, Status Page Announcement, Scheduled Maintenance State, Scheduled Maintenance State Timeline, Label, Monitor Status Event, Security Case, Security Case Note, Security Detection, Security Playbook.

Log, Metric, Span, Exception Instance, Monitor Log, Security Event, Change Event, Kubernetes Cost Allocation, and Threat Intel Indicator get `list_` and `count_` tools only (e.g. `list_logs`, `count_spans`, `list_exception_instances`). There are no create tools for telemetry — ingestion happens via OpenTelemetry.

Purpose-built shortcuts for incident/alert response (`packages/App/FeatureSet/MCP/Tools/WorkflowTools.ts`):

- `acknowledge_incident`, `resolve_incident`
- `acknowledge_alert`, `resolve_alert`
- `add_incident_note` (with `visibility: "internal" | "public"` — public notes post to the status page)
- `add_alert_note`
- `get_data_table_freshness` — whether a table Data Observability watches is fresh: fresh or late by its own rhythm, when it last changed, its open alerts, and its writers' latest runs (read-only)
- `get_data_table_lineage` — what a table Data Observability watches is built from and what is built from it, up to five steps each way (`depth`, three by default): the tables that are late, dropped, have open alerts or whose pipeline failed first, nearest first, then the rest, the pipelines that load it from outside and the BI dashboards built on it (read-only)
- `oneuptime_whoami` — returns the project (ID and name) the credential belongs to; for an OAuth sign-in, also who is signed in, through which client, and whether the connection is read-only

- `oneuptime_help`, `oneuptime_list_resources`
- `oneuptime_describe_resource` — one resource's fields: what each means, the filter operators its type takes, and whether it can be sorted or must be selected. Accepts the resource's name or any of its tool names (`Incident`, `list_incidents`).
- No credential needed: `get_public_status_page_overview`, `get_public_status_page_incidents`, `get_public_status_page_scheduled_maintenance`, `get_public_status_page_announcements`

### Annotations and results

Every tool has a title and states all three MCP hints, set in `Tools/ToolAnnotations.ts`, so clients can auto-approve safe calls and confirm the rest:

- `readOnlyHint: true` on the tools that change nothing: `get_`, `list_`, `count_`, `oneuptime_whoami`, the helper tools and the public status page tools.
- `destructiveHint: true` on every tool that changes something: create, update and delete tools, acknowledging and resolving, and adding notes. Most writes overwrite or delete a record, change an incident's or alert's state, page someone on call or post to a status page, and the directories allow `false` only for a write that adds and sends nothing.
- `openWorldHint: true` only on the public status page tools, which read any public status page on the instance. Every other tool stays inside the caller's project.

MCP directories require them: the Claude Connectors Directory flags any tool without a `title` or a `readOnlyHint`/`destructiveHint`, and ChatGPT's requires all three hints as booleans. `Tests/ToolAnnotationsForDirectories.test.ts` fails on a tool that lacks one, or that breaks the rules above. On the server itself, `MCP_ALLOW_DESTRUCTIVE=false` removes the delete tools only, and `MCP_READ_ONLY=true` removes every tool that is not read-only (`Tests/WritePolicy.test.ts`). Tool results include `structuredContent` alongside the JSON text. Errors come back as in-band tool results (`isError: true`) with `statusCode`, `details`, and a `suggestion` — not as protocol errors.

## The size of tools/list

Many clients load every tool definition before the first question, so `tools/list` is paid for on every connection. On 2026-11-02 oneuptime.com answered it with 283 tools in 1,202,028 bytes (about 300,000 tokens at four characters a token), more than many models hold: each `list_` and `count_` tool listed every field of its model with its operators and an example. On the code that changed this, the answer went from 289 tools in 1,228,155 bytes to 290 tools in 237,400 bytes (about 59,000 tokens):

- `list_` and `count_` tools take any field in `query` and `sort` and say how a filter is written; `oneuptime_describe_resource` gives the fields on demand, one resource at a time.
- Generated schemas carry no examples. A typed value such as a date (`{"_type": "DateTime", "value": ...}`) or a color keeps its shape as schema, since its example was the only place that stated it.
- `create_` tools explain only the fields a call cannot leave out, and `update_` tools name and type their fields without explaining them. Every field is still listed and typed, so a client that validates a call still can.
- Tool names, titles and annotations are unchanged.

`Tests/ToolListBudget.test.ts` reads `tools/list` through the SDK's client and fails above 250,000 bytes, or for any tool above 5,000 bytes. A new model adds about 4 KB. When a change goes over, make the tools say less, or raise the budget in the same change and say why.

## Query, sort, select, and pagination

To find a resource's fields, call `oneuptime_describe_resource` with the resource or one of its tools. It answers with every field, its type and meaning, the operators each type takes and how each is written, and a worked example. `Tests/DescribeResource.test.ts` runs every field and operator it offers through the code the API runs on a query.

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

Operators: `EqualTo`, `NotEqual`, `IsNull`, `NotNull`, `EqualToOrNull`, `GreaterThan`, `LessThan`, `GreaterThanOrEqual`, `LessThanOrEqual`, `InBetween` (with `startValue` and `endValue`), `Search`, `Includes` (with an array). Which a field takes depends on its type. A telemetry map field such as `attributes` is filtered by its keys: `{"attributes": {"http.method": "GET"}}`.

A filter written another way, such as MongoDB's `{"$regex": "..."}` or an operator OneUptime does not have, is refused before it reaches the API, with an error that names the field and says how an operator is written (`Tools/FilterCheck.ts`). The API would pass it on, and the database would compare a text column with the object's JSON and match nothing. A relation filtered by its own fields (`{"currentIncidentState": {"isResolvedState": false}}`) and a map filtered by its keys are filters, and pass.

### Sort

```json
{ "sort": { "createdAt": "DESC" } }
```

Values are `"ASC"` or `"DESC"`. Each telemetry tool names the time column to filter and sort on (`time`, `startTime`, `windowStart` or `validFrom`).

### Select

`get_` and `list_` tools take an optional `select` array of field names, telemetry's included (a `{ "field": true }` object still works). By default all readable fields are returned **except** heavy ones (JSON / VeryLongText / HTML columns), which must be requested explicitly.

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

An incident-response sequence in the advanced profile:

1. `oneuptime_whoami` — confirm which project the credential belongs to.
2. `list_incidents` with `{"sort": {"createdAt": "DESC"}, "limit": 5}` — find the active incident.
3. `acknowledge_incident` — take ownership.
4. `list_logs` with a time-range filter (`{"time": {"_type": "GreaterThan", "value": "..."}}`) and `list_exception_instances` — investigate.
5. `add_incident_note` with `"visibility": "public"` — post a status update for customers.
6. `resolve_incident` — close it out.

## HTTP endpoints

| Endpoint      | Method | Behavior                                                                 |
| ------------- | ------ | ------------------------------------------------------------------------ |
| `/mcp`        | POST   | JSON-RPC (tool calls and all MCP operations)                              |
| `/mcp`        | GET    | Without an SSE `Accept` header: friendly JSON discovery payload. With one: `405` (no standalone SSE stream in stateless mode). |
| `/mcp`        | DELETE | No-op (stateless — nothing to terminate)                                  |
| `/mcp/tools`  | GET    | REST listing of available tools                                           |
| `/mcp/health` | GET    | Health check, including the protocol versions this build speaks           |
| `/mcp/.well-known/oauth-protected-resource` | GET | Protected resource metadata (also at `/.well-known/oauth-protected-resource[/mcp]`) |
| `/.well-known/oauth-authorization-server/mcp` | GET | Authorization server metadata (also at `/mcp/.well-known/oauth-authorization-server` and the origin's root) |
| `/mcp/oauth/authorize` | GET, POST | Authorization endpoint: checks the client's request and redirects to the consent screen |
| `/mcp/oauth/token` | POST | Code exchange and refresh |
| `/mcp/oauth/register` | POST | Dynamic Client Registration |
| `/mcp/oauth/revoke` | POST | Token revocation |
| `/mcp/oauth/consent/{details,approve,deny}` | POST | The consent screen's own calls (session cookie, same origin only) |

## Protocol compatibility

The server negotiates rather than rejects, so a client does not have to match the
MCP SDK bundled in the App container exactly.

**Protocol version.** The `MCP-Protocol-Version` request header is negotiated down
to the highest version both sides support. A header sent twice is read as its
first value — Node collapses repeated headers into one comma-joined string, and
a version never contains a comma:

- a version the server supports is used as-is;
- a version *newer* than anything the server knows about (for example a client on
  a newer revision of the spec) is negotiated down to the server's latest — the
  same answer `initialize` gives;
- a version *older* than everything the server supports, or one that is not a
  `YYYY-MM-DD` version at all, has no common ground. The request is answered with
  `400` and a JSON-RPC error that names the requested version and lists the
  supported ones, instead of failing silently at the transport layer.

An unusable header on an `initialize` request is dropped rather than rejected,
because that request negotiates the version in its body. A header that is
present but *blank* is dropped too: an empty string is not the same as an absent
header to the SDK, which would otherwise reject it like any other unknown
version.

`GET /mcp` and `GET /mcp/health` both list the supported versions, so a failing
handshake can be diagnosed without reading container logs.

**Response format.** A POST is answered with whatever the client's `Accept` header
allows: `text/event-stream` when the client asks for it by name or via the
`text/*` range (what spec-compliant MCP clients do), and a plain
`application/json` body otherwise — including for `Accept: application/json`, an
`application/*` or `*/*` wildcard, or no `Accept` header at all. Both are valid
replies to a POST under the MCP spec. A client that accepts neither gets a `406`
naming the media types the endpoint can produce.

**Diagnostics.** Negotiation logs describe the *client*: they are built from a
snapshot taken before the headers are rewritten, so they report what was
actually sent rather than the values this server normalised them to. Every field
in them — header values and the JSON-RPC method alike — is stripped of control
characters and length-capped, so a caller cannot forge log lines or flood the
log through them. The API key or access token is never logged.

## Self-hosting

The MCP server ships as part of the App container and is served at `/mcp` behind Nginx — no separate deployment is needed. Its tools call the OneUptime API at the App's internal address - `SERVER_APP_HOSTNAME` and `APP_PORT`, the address Nginx proxies `/api` to (inherited from the App service's environment) - never through the public `HOST`, which the App container cannot always reach (with `HOST=localhost` it is the container itself). API keys are never configured on the server; clients supply them per request.

OAuth sign-in needs nothing configured either, but it does depend on `HOST` and `HTTP_PROTOCOL` being the address people actually use: the issuer, the token audience and every endpoint in the discovery documents are built from them. A reverse proxy in front of OneUptime has to forward `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (and everything under them) to the App along with `/mcp`; the bundled Nginx does.

## MCP Registry

OneUptime Cloud's server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io), which MCP clients and directories read, as `com.oneuptime/mcp`. [`server.json`](server.json) is the entry: streamable HTTP at `https://oneuptime.com/mcp`, signed in to with OAuth, or given a project API key in the optional `x-api-key` header. Its `version` is a placeholder, `0.0.0`.

Every release publishes it at the release's version. The `publish-mcp-registry` job in `.github/workflows/release.yml` runs `Scripts/MCP/PublishToMcpRegistry.sh` once the GitHub release is published, and skips a version the registry already has, so re-running a release publishes nothing twice. A published version cannot be changed.

Only whoever controls `oneuptime.com` may publish under `com.oneuptime`. The job signs in with an Ed25519 private key whose public key is in a TXT record on `oneuptime.com`, and it fails, publishing nothing, until both are in place. To set them up (Ed25519 needs OpenSSL 3; on macOS, `brew install openssl@3` and use its `openssl`, not the system LibreSSL):

1. Make a key pair:

   ```bash
   openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
   ```

2. Add a TXT record on `oneuptime.com` itself, not on a subdomain such as `_mcp.oneuptime.com`, with the value this prints:

   ```bash
   echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
   ```

3. In the repository's **Settings → Environments**, create `mcp-registry-publish`, limit its deployment branches to `release`, and give it the secret `MCP_REGISTRY_PRIVATE_KEY`: the private key in hex, which this prints:

   ```bash
   openssl pkey -in mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
   ```

Then delete `mcp-registry-key.pem`, or keep it somewhere safe: whoever has the key can publish, and overwrite, any entry under `com.oneuptime`. To change the key, replace the TXT record and the secret together; an old record left beside the new one is tried first and fails the sign-in.

To publish before the next release, run the script by hand from the repository root, with [`mcp-publisher`](https://github.com/modelcontextprotocol/registry/releases) and `jq` installed: `PACKAGE_VERSION=<version> MCP_REGISTRY_PRIVATE_KEY=<hex key> bash Scripts/MCP/PublishToMcpRegistry.sh`.

## ChatGPT plugin directory

[`ChatGPTPlugin/`](ChatGPTPlugin/README.md) is the package OneUptime uploads to the ChatGPT plugin directory, which ChatGPT and Codex share: the listing, five positive and three negative review test cases, and `mcp.json`, which points at `https://oneuptime.com/mcp` and signs in with OAuth for read and write access. `npm run build-chatgpt-plugin` builds the ZIP, and adds the coding agent plugin's four skills, which ChatGPT and Codex load. Its README lists what else a submission needs: a verified developer identity, a domain-verification token served at `https://oneuptime.com/.well-known/openai-apps-challenge`, reviewer credentials for a demo project, and a demo video. `Tests/ChatGPTPlugin.test.ts` holds the package to the Agent Plugins schemas and OpenAI's limits, and checks that every tool a test case names is one this server has.

## Coding agent plugin

[`CodingAgentPlugin/`](CodingAgentPlugin/README.md) is the plugin OneUptime lists for coding agents in Cursor's Marketplace and the Claude directory. It holds the hosted server's address and four skills: adding OpenTelemetry, setting up monitors and a status page, investigating an incident, and using the CLI in scripts and CI. `npm run build-coding-agent-plugin` builds a folder with the Agent Plugins, Cursor and Claude manifests side by side, taking the listing's words, links and icon from `ChatGPTPlugin/`. Both directories read a plugin from a public Git repository of its own, `OneUptime/oneuptime-agent-plugin`. Each release that changes the plugin publishes it there, through the `publish-coding-agent-plugin` job in `.github/workflows/release.yml`. A maintainer creates the repository and its deploy key once, and submits it to the directories: the package's README lists those steps. `Tests/CodingAgentPlugin.test.ts` runs the build, checks the folder against the Agent Plugins schemas and each directory's rules, and checks every tool and JSON example a skill names against this server.

Organization filters accept the positive numeric application organization ID as a
string, for example `"organization": "13"`. The MCP queries the stored
`organization.id` attribute directly; names and public IDs are rejected.
The KugelAudio monorepo owns the release-event producer and deployment
configuration under `packages/private/ci/release/` and `infrastructure/oneuptime/`.

## Development

The MCP server lives in `packages/App/FeatureSet/MCP` and is mounted into the App service at startup (`packages/App/Index.ts`). Tests live in `packages/App/FeatureSet/MCP/Tests` and run as part of the App test suite:

```bash
cd packages/App
npm install
npx jest ./FeatureSet/MCP/Tests --runInBand
```

New models are picked up automatically: decorate a database model with `@EnableMCP` (or set `enableMCP` on an analytics model) and the tool generator creates its tools on the next start.

## License

Apache-2.0 - See LICENSE file for details.
