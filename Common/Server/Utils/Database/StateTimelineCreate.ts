import DatabaseBaseModel from "../../../Models/DatabaseModels/DatabaseBaseModel/DatabaseBaseModel";
import BadDataException from "../../../Types/Exception/BadDataException";
import ObjectID from "../../../Types/ObjectID";
import CreateBy from "../../Types/Database/CreateBy";
import { resolveReferenceId } from "./ProjectScopedReferenceValidator";

export interface StateTimelineReference {
  // Human readable name of the referenced model, e.g. "Alert State".
  modelName: string;
  idColumn: string;
  relationColumn: string;
}

/*
 * A state timeline row is validated, looked up and followed up by its id
 * columns, but a create may also carry relation objects, and those can decide
 * the join column that is saved. Every reference is collapsed to its id column
 * before anything reads it.
 */
export default class StateTimelineCreate {
  public static canonicalize<TModel extends DatabaseBaseModel>(data: {
    createBy: CreateBy<TModel>;
    subject: string;
    references: Array<StateTimelineReference>;
  }): void {
    const row: Record<string, unknown> = data.createBy
      .data as unknown as Record<string, unknown>;
    const tenantId: ObjectID | undefined = data.createBy.props.tenantId;
    const references: Array<StateTimelineReference> = [...data.references];

    if (tenantId) {
      // The authenticated project alone says who owns the row.
      row["projectId"] = tenantId;
      delete row["project"];
    } else {
      references.push({
        modelName: "Project",
        idColumn: "projectId",
        relationColumn: "project",
      });
    }

    // A caller's own row id would turn the save into an update of that row.
    if (!data.createBy.props.isRoot) {
      delete row["_id"];
    }

    for (const reference of references) {
      const relation: unknown = row[reference.relationColumn];
      const ids: Array<string> = [
        row[reference.idColumn],
        resolveReferenceId(relation),
      ]
        .filter(Boolean)
        .map((id: unknown) => {
          return String(id).trim().toLowerCase();
        });

      if (
        new Set(ids).size > 1 ||
        (relation && !resolveReferenceId(relation))
      ) {
        throw new BadDataException(
          `This ${data.subject} must name one ${reference.modelName}: its id and relation disagree.`,
        );
      }

      delete row[reference.relationColumn];

      if (ids[0]) {
        row[reference.idColumn] = new ObjectID(ids[0]);
      }
    }
  }
}
