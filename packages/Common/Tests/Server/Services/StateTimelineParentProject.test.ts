import AlertService from "../../../Server/Services/AlertService";
import AlertStateService from "../../../Server/Services/AlertStateService";
import AlertStateTimelineService from "../../../Server/Services/AlertStateTimelineService";
import IncidentService from "../../../Server/Services/IncidentService";
import IncidentStateService from "../../../Server/Services/IncidentStateService";
import IncidentStateTimelineService from "../../../Server/Services/IncidentStateTimelineService";
import ApiKeyPermissionService from "../../../Server/Services/ApiKeyPermissionService";
import Semaphore from "../../../Server/Infrastructure/Semaphore";
import APIKeyAccessPermission from "../../../Server/Utils/APIKey/AccessPermission";
import ProjectScopedReferenceValidator from "../../../Server/Utils/Database/ProjectScopedReferenceValidator";
import AlertStateTimeline from "../../../Models/DatabaseModels/AlertStateTimeline";
import BaseModel from "../../../Models/DatabaseModels/DatabaseBaseModel/DatabaseBaseModel";
import IncidentStateTimeline from "../../../Models/DatabaseModels/IncidentStateTimeline";
import DatabaseCommonInteractionProps from "../../../Types/BaseDatabase/DatabaseCommonInteractionProps";
import { JSONObject } from "../../../Types/JSON";
import ObjectID from "../../../Types/ObjectID";
import Permission from "../../../Types/Permission";
import UserType from "../../../Types/UserType";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

/*
 * A state timeline row rewrites its parent's earlier rows as root, so one
 * parent, state and project must be validated, saved and followed up. These
 * run the real create entry point on a payload shaped as the API receives it;
 * only lookups, the save and the parent update are faked. On 14 the create
 * path itself refuses disagreeing names, a caller's row id and a parent the
 * caller cannot read; the hook's own project-filtered parent check covers the
 * root-run creates that path lets through.
 */

const PROJECT_ID: string = "4af3a31b-58b0-4746-8025-f9cd4db1945e";
const OTHER_PROJECT_ID: string = "3376855b-361c-427c-8982-bad7ada30414";
const OWN_ID: string = "59b5ab80-63f6-4ffd-b3df-31c6ad127695";
const OWN_ID_2: string = "0d9f2a51-6c0e-4a8e-9a55-2f6a7b1c3d4e";
const FOREIGN_ID: string = "cfc2f04f-79cb-4344-8c54-dafe5e3a290c";
const MISSING_ID: string = "11b1f0c2-9f7a-4d4b-8f0a-5c6d7e8f9a0b";
const STATE_ID: string = "a2eb67d4-bd2e-4186-9187-dad799c9316c";
const STATE_ID_2: string = "b7c1d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e";

const PARENT_PROJECTS: Record<string, string> = {
  [OWN_ID]: PROJECT_ID,
  [OWN_ID_2]: PROJECT_ID,
  [FOREIGN_ID]: OTHER_PROJECT_ID,
};

const cases: Array<[string, any, any, any, any]> = [
  [
    "alert",
    AlertStateTimelineService,
    AlertStateTimeline,
    AlertService,
    AlertStateService,
  ],
  [
    "incident",
    IncidentStateTimelineService,
    IncidentStateTimeline,
    IncidentService,
    IncidentStateService,
  ],
];

describe.each(cases)(
  "%s state timeline create",
  (kind: string, timeline: any, model: any, parent: any, state: any) => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const fake: () => {
      save: jest.Mock;
      timelineRead: jest.Mock;
      parentUpdate: jest.Mock;
    } = () => {
      // The narrow key's grants for creating and following up a state.
      jest
        .spyOn(ApiKeyPermissionService, "findPermissionsByApiKeyId")
        .mockResolvedValue(
          [
            Permission.CreateAlertStateTimeline,
            Permission.EditAlert,
            Permission.CreateIncidentStateTimeline,
            Permission.EditProjectIncident,
          ].map((permission: Permission) => {
            return { permission, labelIds: [], isBlockPermission: false };
          }) as never,
        );
      jest.spyOn(Semaphore, "lock").mockResolvedValue({} as never);
      jest.spyOn(Semaphore, "release").mockResolvedValue(undefined as never);
      jest.spyOn(parent, "findOneBy").mockImplementation((async (find: {
        query: { _id: ObjectID; projectId: ObjectID };
      }) => {
        const id: string = find.query._id.toString();
        return PARENT_PROJECTS[id] === find.query.projectId.toString()
          ? { _id: id }
          : null;
      }) as never);
      jest.spyOn(state, "findBy").mockImplementation((async () => {
        return [STATE_ID, STATE_ID_2].map((id: string) => {
          return {
            _id: id,
            getValue: (column: string) => {
              return column === "projectId"
                ? new ObjectID(PROJECT_ID)
                : undefined;
            },
          };
        });
      }) as never);
      const save: jest.Mock = jest.fn(async (row: unknown) => {
        return row;
      }) as unknown as jest.Mock;
      jest.spyOn(timeline, "getRepository").mockReturnValue({ save } as never);
      return {
        save,
        timelineRead: jest
          .spyOn(timeline, "findOneBy")
          .mockResolvedValue(null as never) as unknown as jest.Mock,
        // Ends the post-save work right after the write that moves the parent.
        parentUpdate: jest
          .spyOn(parent, "updateOneBy")
          .mockRejectedValue(
            new Error("stop here") as never,
          ) as unknown as jest.Mock,
      };
    };

    const create: (payload: JSONObject) => Promise<unknown> = async (
      payload: JSONObject,
    ): Promise<unknown> => {
      const projectId: ObjectID = new ObjectID(PROJECT_ID);
      const props: DatabaseCommonInteractionProps = {
        tenantId: projectId,
        userType: UserType.API,
        userGlobalAccessPermission:
          await APIKeyAccessPermission.getDefaultApiGlobalPermission(projectId),
        userTenantAccessPermission: {
          [PROJECT_ID]:
            await APIKeyAccessPermission.getApiTenantAccessPermission(
              projectId,
              ObjectID.generate(),
            ),
        },
      };
      return timeline.create({
        data: BaseModel.fromJSON(payload, model),
        props,
      });
    };

    const rejection: (payload: JSONObject) => Promise<string> = async (
      payload: JSONObject,
    ): Promise<string> => {
      try {
        await create(payload);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("the create was accepted");
    };

    it.each([
      ["parent", { [`${kind}Id`]: OWN_ID, [kind]: { _id: OWN_ID_2 } }],
      ["parent", { [`${kind}Id`]: OWN_ID, [kind]: { _id: FOREIGN_ID } }],
      [
        "state",
        {
          [`${kind}Id`]: OWN_ID,
          [`${kind}State`]: { _id: STATE_ID_2 },
        },
      ],
    ])(
      "rejects a %s id and relation that disagree",
      async (_what: string, references: JSONObject) => {
        const { save, timelineRead } = fake();

        await expect(
          rejection({ [`${kind}StateId`]: STATE_ID, ...references }),
        ).resolves.toContain("references were provided");
        expect(timelineRead).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        "id",
        (id: string) => {
          return { [`${kind}Id`]: id };
        },
      ],
      [
        "relation",
        (id: string) => {
          return { [kind]: { _id: id } };
        },
      ],
    ])(
      "answers alike for a missing and a foreign parent named by %s",
      async (_how: string, named: (id: string) => JSONObject) => {
        const { save, timelineRead } = fake();

        const [foreign, missing] = [
          await rejection({
            [`${kind}StateId`]: STATE_ID,
            ...named(FOREIGN_ID),
          }),
          await rejection({
            [`${kind}StateId`]: STATE_ID,
            ...named(MISSING_ID),
          }),
        ];

        expect(foreign).toContain(
          `It is read through its ${kind === "alert" ? "Alert" : "Incident"}`,
        );
        expect(missing).toBe(foreign.replace(FOREIGN_ID, MISSING_ID));
        expect(timelineRead).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      },
    );

    // A root-run create (a worker, a workflow) skips the caller's parent read.
    const beforeCreate: (parentId: string) => Promise<unknown> = (
      parentId: string,
    ): Promise<unknown> => {
      // The state's own check is MissingReferenceWriteGuard's; this is the parent's.
      jest
        .spyOn(
          ProjectScopedReferenceValidator,
          "validateReferencesBelongToProject",
        )
        .mockResolvedValue(undefined as never);
      const hooks: Record<string, (input: unknown) => Promise<unknown>> =
        timeline as unknown as Record<
          string,
          (input: unknown) => Promise<unknown>
        >;
      return hooks["onBeforeCreate"]!.apply(timeline, [
        {
          data: BaseModel.fromJSON(
            {
              projectId: PROJECT_ID,
              [`${kind}Id`]: parentId,
              [`${kind}StateId`]: STATE_ID,
            },
            model,
          ),
          props: { isRoot: true },
        },
      ]);
    };

    const hookRejection: (parentId: string) => Promise<string> = async (
      parentId: string,
    ): Promise<string> => {
      try {
        await beforeCreate(parentId);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("the create was accepted");
    };

    it("refuses a root-run create whose parent is missing or of another project, alike", async () => {
      const { save, timelineRead } = fake();

      const [foreign, missing] = [
        await hookRejection(FOREIGN_ID),
        await hookRejection(MISSING_ID),
      ];

      expect(foreign).toContain("not available in this project");
      expect(missing).toBe(foreign.replace(FOREIGN_ID, MISSING_ID));
      expect(timelineRead).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it("lets a root-run create under its own project's parent go on to the timeline", async () => {
      const { timelineRead } = fake();
      timelineRead.mockRejectedValue(new Error("stop here") as never);

      await expect(hookRejection(OWN_ID)).resolves.toBe("stop here");
      expect(
        (timelineRead.mock.calls[0]![0] as any).query[`${kind}Id`].toString(),
      ).toBe(OWN_ID);
    });
  },
);
