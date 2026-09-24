import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import ObjectID from "Common/Types/ObjectID";
import OneUptimeDate from "Common/Types/Date";
import AnalyticsTableName from "Common/Types/AnalyticsDatabase/AnalyticsTableName";
import ServiceType from "Common/Types/Telemetry/ServiceType";
import { Statement } from "Common/Server/Utils/AnalyticsDatabase/Statement";

/*
 * The Kubernetes cluster facet on the Logs page listed every cluster with a
 * count of 0 while hundreds of thousands of rows per hour came from those
 * clusters. Pod logs, OTLP logs and the kubernetes-agent k8sobjects rows are
 * primary-keyed on a Service (primaryEntityType 'OpenTelemetry') and carry
 * the cluster only as the ingest-stamped
 * attributes['oneuptime.kubernetes.cluster.id'], so a facet that counted
 * primaryEntityId WHERE primaryEntityType = 'KubernetesCluster' found none of
 * them. These tests pin the SQL of the three places the cluster predicate
 * has to agree: the facet count, the aggregation filters (histogram, other
 * facets, analytics) and the list query.
 *
 * Postgres is mocked: the unit under test is the SQL, not the lookup.
 */
type FindBy = (...args: Array<unknown>) => Promise<Array<unknown>>;
type FindByMock = ReturnType<typeof jest.fn<FindBy>>;

const kubernetesClusterFindBy: FindByMock = jest.fn<FindBy>();
const hostFindBy: FindByMock = jest.fn<FindBy>();

jest.mock("Common/Server/Services/KubernetesClusterService", () => {
  return { __esModule: true, default: { findBy: kubernetesClusterFindBy } };
});
jest.mock("Common/Server/Services/HostService", () => {
  return { __esModule: true, default: { findBy: hostFindBy } };
});

import LogAggregationService, {
  FacetRequest,
  HistogramRequest,
} from "Common/Server/Services/LogAggregationService";
import ResourceEntityFilter, {
  KUBERNETES_CLUSTER_ID_ATTRIBUTE_KEY,
  ResourceEntityScope,
} from "Common/Server/Utils/Telemetry/ResourceEntityFilter";
import StatementGenerator from "Common/Server/Utils/AnalyticsDatabase/StatementGenerator";
import Log from "Common/Models/AnalyticsModels/Log";

const PROJECT_ID: ObjectID = new ObjectID(
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
);
const CLUSTER_ID: string = "8c0f2f1e-2e4f-4a8c-9a1a-2f5b6c7d8e9f";
const HOST_ID: string = "5f4e3d2c-1b0a-4998-8776-655443322110";
const START: Date = new Date("2026-09-24T10:00:00.000Z");
const END: Date = new Date("2026-09-24T11:00:00.000Z");

const FACET_SETTINGS: string =
  " SETTINGS max_execution_time = 45, timeout_overflow_mode = 'break', max_memory_usage = 3221225472, max_bytes_before_external_group_by = 1610612736, max_bytes_before_external_sort = 1610612736, max_block_size = 8192, preferred_block_size_bytes = 1048576, max_threads = 4";

function buildFacetStatement(overrides: Partial<FacetRequest>): Statement {
  return (LogAggregationService as any).buildFacetStatement({
    projectId: PROJECT_ID,
    startTime: START,
    endTime: END,
    facetKey: "kubernetesClusterId",
    limit: 500,
    ...overrides,
  } as FacetRequest);
}

function buildHistogramStatement(
  overrides: Partial<HistogramRequest>,
): Statement {
  return (LogAggregationService as any).buildHistogramStatement({
    projectId: PROJECT_ID,
    startTime: START,
    endTime: END,
    bucketSizeInMinutes: 1,
    ...overrides,
  } as HistogramRequest);
}

async function resolveClusterScopes(): Promise<Array<ResourceEntityScope>> {
  return ResourceEntityFilter.resolveScopes({
    projectId: PROJECT_ID,
    selections: { kubernetesClusterId: [CLUSTER_ID] },
  });
}

describe("Logs Kubernetes cluster facet", () => {
  beforeEach(() => {
    kubernetesClusterFindBy.mockReset();
    hostFindBy.mockReset();
    kubernetesClusterFindBy.mockResolvedValue([
      { clusterIdentifier: "verda-eu-prod" },
    ]);
    hostFindBy.mockResolvedValue([{ hostIdentifier: "web-1" }]);
  });

  test("the attribute key is the one ingest stamps on every row", () => {
    expect(KUBERNETES_CLUSTER_ID_ATTRIBUTE_KEY).toBe(
      "oneuptime.kubernetes.cluster.id",
    );
  });

  test("counts rows stamped with the cluster id attribute as well as cluster-primary rows", () => {
    const statement: Statement = buildFacetStatement({});

    /*
     * One value per row (the if() picks exactly one), so a row that is both
     * cluster-primary and stamped is counted once.
     */
    expect(statement.query).toBe(
      "SELECT if(primaryEntityType = {p0:String}, toString(primaryEntityId), attributes[{p1:String}]) AS val, count() AS cnt FROM {p2:Identifier}" +
        " WHERE projectId = {p3:String} AND time >= {p4:DateTime} AND time <= {p5:DateTime}" +
        " AND (primaryEntityType = {p6:String} OR attributes[{p7:String}] != '')" +
        " AND retentionDate >= now() GROUP BY val ORDER BY cnt DESC LIMIT {p8:Int32}" +
        FACET_SETTINGS,
    );

    expect(statement.query_params).toStrictEqual({
      p0: ServiceType.KubernetesCluster,
      p1: "oneuptime.kubernetes.cluster.id",
      p2: AnalyticsTableName.Log,
      p3: PROJECT_ID.toString(),
      p4: OneUptimeDate.toClickhouseDateTime(START),
      p5: OneUptimeDate.toClickhouseDateTime(END),
      p6: ServiceType.KubernetesCluster,
      p7: "oneuptime.kubernetes.cluster.id",
      p8: 500,
    });
  });

  test("leaves the host facet on the primaryEntityType discriminator", () => {
    const statement: Statement = buildFacetStatement({ facetKey: "hostId" });

    expect(statement.query).toBe(
      "SELECT toString(primaryEntityId) AS val, count() AS cnt FROM {p0:Identifier}" +
        " WHERE projectId = {p1:String} AND time >= {p2:DateTime} AND time <= {p3:DateTime}" +
        " AND primaryEntityType = {p4:String}" +
        " AND retentionDate >= now() GROUP BY val ORDER BY cnt DESC LIMIT {p5:Int32}" +
        FACET_SETTINGS,
    );
    expect(statement.query_params["p4"]).toBe(ServiceType.Host);
  });

  test("a selected cluster scope matches the cluster id attribute", async () => {
    const scopes: Array<ResourceEntityScope> = await resolveClusterScopes();

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.entityIds).toEqual([CLUSTER_ID]);
    expect(scopes[0]!.idAttributeKey).toBe("oneuptime.kubernetes.cluster.id");
  });

  test("keeps the cluster id attribute branch when the Postgres lookup fails", async () => {
    kubernetesClusterFindBy.mockRejectedValue(new Error("postgres down"));

    const scopes: Array<ResourceEntityScope> = await resolveClusterScopes();

    expect(scopes[0]!.entityKeys).toEqual([]);
    expect(scopes[0]!.idAttributeKey).toBe("oneuptime.kubernetes.cluster.id");
  });

  test("a selected host scope has no id attribute branch", async () => {
    const scopes: Array<ResourceEntityScope> =
      await ResourceEntityFilter.resolveScopes({
        projectId: PROJECT_ID,
        selections: { hostId: [HOST_ID] },
      });

    expect(scopes[0]!.idAttributeKey).toBeUndefined();
  });

  test("the histogram filters on the same cluster predicate", async () => {
    const resourceScopes: Array<ResourceEntityScope> =
      await resolveClusterScopes();

    const statement: Statement = buildHistogramStatement({ resourceScopes });

    expect(statement.query).toContain(
      "AND (primaryEntityId IN ({p5:Array(String)}) OR attributes[{p6:String}] IN ({p7:Array(String)}) OR hasAny(entityKeys, {p8:Array(String)}) OR attributes[{p9:String}] IN ({p10:Array(String)}))",
    );
    expect(statement.query_params["p5"]).toEqual([CLUSTER_ID]);
    expect(statement.query_params["p6"]).toBe(
      "oneuptime.kubernetes.cluster.id",
    );
    expect(statement.query_params["p7"]).toEqual([CLUSTER_ID]);
    expect(statement.query_params["p9"]).toBe("resource.k8s.cluster.name");
    expect(statement.query_params["p10"]).toEqual(["verda-eu-prod"]);
  });

  test("other facets are narrowed by the same cluster predicate", async () => {
    const resourceScopes: Array<ResourceEntityScope> =
      await resolveClusterScopes();

    const statement: Statement = buildFacetStatement({
      facetKey: "severityText",
      resourceScopes,
    });

    expect(statement.query).toContain(
      "AND (primaryEntityId IN ({p5:Array(String)}) OR attributes[{p6:String}] IN ({p7:Array(String)}) OR hasAny(entityKeys, {p8:Array(String)}) OR attributes[{p9:String}] IN ({p10:Array(String)}))",
    );
    expect(statement.query_params["p6"]).toBe(
      "oneuptime.kubernetes.cluster.id",
    );
    expect(statement.query_params["p7"]).toEqual([CLUSTER_ID]);
  });

  test("the list query compiles the same cluster predicate", async () => {
    const query: Record<string, unknown> = {
      resourceFilters: { kubernetesClusterId: [CLUSTER_ID] },
    };

    await ResourceEntityFilter.rewriteAnalyticsQuery({
      query,
      projectId: PROJECT_ID,
    });

    const generator: StatementGenerator<Log> = new StatementGenerator<Log>({
      modelType: Log,
      database: undefined as any,
    });

    const statement: Statement = generator.toWhereStatement(query as any);

    expect(statement.query).toBe(
      "AND ({p0:Identifier} IN {p1:Array(String)} OR {p2:Identifier}[{p3:String}] IN {p4:Array(String)} OR hasAny({p5:Identifier}, {p6:Array(String)}) OR {p7:Identifier}[{p8:String}] IN {p9:Array(String)})",
    );
    expect(statement.query_params).toMatchObject({
      p0: "primaryEntityId",
      p1: [CLUSTER_ID],
      p2: "attributes",
      p3: "oneuptime.kubernetes.cluster.id",
      p4: [CLUSTER_ID],
      p5: "entityKeys",
      p7: "attributes",
      p8: "resource.k8s.cluster.name",
      p9: ["verda-eu-prod"],
    });
  });

  test("the list query keeps the id attribute branch without a tenant", async () => {
    const query: Record<string, unknown> = {
      resourceFilters: { kubernetesClusterId: [CLUSTER_ID] },
    };

    await ResourceEntityFilter.rewriteAnalyticsQuery({ query });

    const generator: StatementGenerator<Log> = new StatementGenerator<Log>({
      modelType: Log,
      database: undefined as any,
    });

    const statement: Statement = generator.toWhereStatement(query as any);

    expect(statement.query).toBe(
      "AND ({p0:Identifier} IN {p1:Array(String)} OR {p2:Identifier}[{p3:String}] IN {p4:Array(String)})",
    );
    expect(statement.query_params["p3"]).toBe(
      "oneuptime.kubernetes.cluster.id",
    );
  });
});
