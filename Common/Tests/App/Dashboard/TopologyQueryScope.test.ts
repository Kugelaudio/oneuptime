import {
  buildTopologyInventoryItemQuery,
  buildTopologyRelationshipQuery,
} from "../../../../App/FeatureSet/Dashboard/src/Components/Topology/TopologyInventoryData";
import ObjectID from "../../../Types/ObjectID";
import EntityType from "../../../Types/Telemetry/EntityType";
import EntityRelationshipType from "../../../Types/Telemetry/EntityRelationshipType";

const projectId: ObjectID = new ObjectID(
  "956e51cb-d8d4-43e8-87ca-a59ce138f133",
);
const since: Date = new Date("2026-09-05T16:00:00Z");
interface RelationshipRow {
  relationshipType: EntityRelationshipType;
  target: string;
}

test("service dependencies survive a catalog with more than one page of containment links", () => {
  const rows: Array<{
    relationshipType: EntityRelationshipType;
    target: string;
  }> = [
    ...Array.from({ length: 10000 }, () => {
      return { relationshipType: EntityRelationshipType.RunsOn, target: "pod" };
    }),
    {
      relationshipType: EntityRelationshipType.DependsOn,
      target: "normalizer",
    },
    { relationshipType: EntityRelationshipType.DependsOn, target: "tts" },
  ];
  const query: ReturnType<typeof buildTopologyRelationshipQuery> =
    buildTopologyRelationshipQuery(projectId, since, true);
  const firstPage: Array<RelationshipRow> = rows
    .filter((row: RelationshipRow) => {
      return (
        !query.relationshipType ||
        row.relationshipType === query.relationshipType
      );
    })
    .slice(0, 10000);
  expect(
    firstPage.map((row: RelationshipRow) => {
      return row.target;
    }),
  ).toEqual(["normalizer", "tts"]);
});

test("quiet service nodes remain in the catalog while unrelated infrastructure cannot crowd them out", () => {
  const query: ReturnType<typeof buildTopologyInventoryItemQuery> =
    buildTopologyInventoryItemQuery(projectId, true);
  expect(query).toEqual({
    projectId,
    isArchived: false,
    entityType: EntityType.Service,
  });
  expect(query.lastSeenAt).toBeUndefined();
});

test("infrastructure retains its complete catalog and relationship types", () => {
  expect(buildTopologyInventoryItemQuery(projectId, false)).toEqual({
    projectId,
    isArchived: false,
  });
  expect(
    buildTopologyRelationshipQuery(projectId, since, false).relationshipType,
  ).toBeUndefined();
});
