import { describe, expect, test } from "@jest/globals";
import ObjectID from "Common/Types/ObjectID";
import ServiceType from "Common/Types/Telemetry/ServiceType";
import { Statement } from "Common/Server/Utils/AnalyticsDatabase/Statement";
import LogAggregationService, {
  FacetRequest,
} from "Common/Server/Services/LogAggregationService";

/*
 * Kugelaudio fork (#21, ported onto 14.0.x): the Kubernetes cluster facet on
 * the Logs page listed every cluster with a count of 0. Pod logs, OTLP logs
 * and the kubernetes-agent k8sobjects rows are primary-keyed on a Service and
 * carry the cluster as the ingest-stamped
 * attributes['oneuptime.kubernetes.cluster.id'], so the facet counts those
 * rows as well as cluster-primary rows.
 */
const PROJECT_ID: ObjectID = new ObjectID(
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
);

function buildFacetStatement(facetKey: string): Statement {
  type Builder = { buildFacetStatement: (request: FacetRequest) => Statement };
  return (LogAggregationService as unknown as Builder).buildFacetStatement({
    projectId: PROJECT_ID,
    startTime: new Date("2026-09-24T10:00:00.000Z"),
    endTime: new Date("2026-09-24T11:00:00.000Z"),
    facetKey,
    limit: 500,
  } as FacetRequest);
}

function paramValues(statement: Statement): Array<unknown> {
  return Object.values(statement.query_params as Record<string, unknown>);
}

describe("Logs Kubernetes cluster facet", () => {
  test("counts rows stamped with the cluster id attribute as well as cluster-primary rows", () => {
    const statement: Statement = buildFacetStatement("kubernetesClusterId");

    expect(statement.query).toMatch(
      /^SELECT if\(primaryEntityType = \{p0:String\}, toString\(primaryEntityId\), attributes\[\{p1:String\}\]\) AS val, count\(\) AS cnt FROM /,
    );
    expect(statement.query).toMatch(
      /AND \(primaryEntityType = \{p\d+:String\} OR attributes\[\{p\d+:String\}\] != ''\)/,
    );
    expect(statement.query_params["p0"]).toBe(ServiceType.KubernetesCluster);
    expect(statement.query_params["p1"]).toBe(
      "oneuptime.kubernetes.cluster.id",
    );
  });

  test("leaves the host facet on the primaryEntityType discriminator", () => {
    const statement: Statement = buildFacetStatement("hostId");

    expect(statement.query).toMatch(
      /^SELECT toString\(primaryEntityId\) AS val, count\(\) AS cnt FROM /,
    );
    expect(statement.query).not.toContain("if(");
    expect(statement.query).not.toContain("oneuptime.kubernetes.cluster.id");
    expect(paramValues(statement)).toContain(ServiceType.Host);
  });
});
