import InventoryItem from "Common/Models/DatabaseModels/InventoryItem";
import InventoryItemRelationship from "Common/Models/DatabaseModels/InventoryItemRelationship";
import Query from "Common/Types/BaseDatabase/Query";
import ObjectID from "Common/Types/ObjectID";
import EntityType from "Common/Types/Telemetry/EntityType";
import EntityRelationshipType from "Common/Types/Telemetry/EntityRelationshipType";
import GreaterThanOrEqual from "Common/Types/BaseDatabase/GreaterThanOrEqual";

/**
 * Inventory is the durable catalog behind Topology. The time picker limits
 * observed relationships, but it must not hide an otherwise current catalog
 * item merely because that item has not emitted telemetry recently.
 */
export function buildTopologyInventoryItemQuery(
  projectId: ObjectID,
  serviceMap: boolean = false,
): Query<InventoryItem> {
  return {
    projectId,
    isArchived: false,
    ...(serviceMap ? { entityType: EntityType.Service } : {}),
  };
}

/** Filter before pagination: containment rows must not crowd out service calls. */
export function buildTopologyRelationshipQuery(
  projectId: ObjectID,
  since: Date,
  serviceMap: boolean,
): Query<InventoryItemRelationship> {
  return {
    projectId,
    lastSeenAt: new GreaterThanOrEqual<Date>(since),
    ...(serviceMap
      ? { relationshipType: EntityRelationshipType.DependsOn }
      : {}),
  };
}

/**
 * The Infrastructure tab is Inventory's complete visual catalog: every loaded
 * item is a node, including items which have no known relationship yet. Edges
 * are added independently from the selected telemetry window. Keeping node
 * membership independent from edges prevents a quiet or manually registered
 * resource from disappearing from the map.
 */
export function getInfrastructureGraphNodeKeys(data: {
  entities: Array<InventoryItem>;
  infrastructureRelationships: Array<InventoryItemRelationship>;
}): Set<string> {
  const keys: Set<string> = new Set<string>();

  for (const entity of data.entities) {
    if (entity.entityKey) {
      keys.add(entity.entityKey);
    }
  }

  for (const relationship of data.infrastructureRelationships) {
    if (relationship.fromEntityKey) {
      keys.add(relationship.fromEntityKey);
    }
    if (relationship.toEntityKey) {
      keys.add(relationship.toEntityKey);
    }
  }

  return keys;
}
