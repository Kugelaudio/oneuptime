import AlertService from "../../../Server/Services/AlertService";
import AlertStateService from "../../../Server/Services/AlertStateService";
import AlertStateTimelineService from "../../../Server/Services/AlertStateTimelineService";
import IncidentService from "../../../Server/Services/IncidentService";
import IncidentStateService from "../../../Server/Services/IncidentStateService";
import IncidentStateTimelineService from "../../../Server/Services/IncidentStateTimelineService";
import Semaphore from "../../../Server/Infrastructure/Semaphore";
import ObjectID from "../../../Types/ObjectID";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

/*
 * A state timeline row rewrites its parent's earlier rows as root. The parent
 * must belong to the caller's project before any of those rows is read.
 */

const PROJECT_ID: ObjectID = new ObjectID(
  "4af3a31b-58b0-4746-8025-f9cd4db1945e",
);
const OTHER_PROJECT_ID: ObjectID = new ObjectID(
  "3376855b-361c-427c-8982-bad7ada30414",
);
const OWN_ID: string = "59b5ab80-63f6-4ffd-b3df-31c6ad127695";
const FOREIGN_ID: string = "cfc2f04f-79cb-4344-8c54-dafe5e3a290c";
const STATE_ID: string = "a2eb67d4-bd2e-4186-9187-dad799c9316c";

const record: (id: string, projectId: ObjectID) => any = (
  id: string,
  projectId: ObjectID,
): any => {
  return {
    _id: id,
    getValue: (column: string) => {
      return column === "projectId" ? projectId : undefined;
    },
  };
};

const cases: Array<[string, any, any, any]> = [
  ["alert", AlertStateTimelineService, AlertService, AlertStateService],
  [
    "incident",
    IncidentStateTimelineService,
    IncidentService,
    IncidentStateService,
  ],
];

describe.each(cases)(
  "%s state timeline parent project",
  (kind: string, timeline: any, parent: any, state: any) => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const create: (data: Record<string, unknown>) => Promise<unknown> = (
      data: Record<string, unknown>,
    ): Promise<unknown> => {
      return timeline.onBeforeCreate({
        data: {
          projectId: PROJECT_ID,
          [`${kind}StateId`]: new ObjectID(STATE_ID),
          ...data,
        },
        props: { tenantId: PROJECT_ID },
      });
    };

    const mock: (found: string) => jest.Mock = (found: string): jest.Mock => {
      jest.spyOn(Semaphore, "lock").mockResolvedValue({} as never);
      jest.spyOn(Semaphore, "release").mockResolvedValue(undefined as never);
      const projectId: ObjectID =
        found === OWN_ID ? PROJECT_ID : OTHER_PROJECT_ID;
      jest
        .spyOn(parent, "findBy")
        .mockResolvedValue([record(found, projectId)] as never);
      jest
        .spyOn(state, "findBy")
        .mockResolvedValue([record(STATE_ID, PROJECT_ID)] as never);
      return jest
        .spyOn(timeline, "findOneBy")
        .mockResolvedValue(null as never) as unknown as jest.Mock;
    };

    it("rejects a parent id from another project", async () => {
      const timelineRead: jest.Mock = mock(FOREIGN_ID);

      await expect(
        create({ [`${kind}Id`]: new ObjectID(FOREIGN_ID) }),
      ).rejects.toThrow("belong to a different project");
      expect(timelineRead).not.toHaveBeenCalled();
    });

    it("rejects a parent relation from another project", async () => {
      const timelineRead: jest.Mock = mock(FOREIGN_ID);

      await expect(
        create({
          [`${kind}Id`]: new ObjectID(OWN_ID),
          [kind]: { _id: FOREIGN_ID },
        }),
      ).rejects.toThrow("belong to a different project");
      expect(timelineRead).not.toHaveBeenCalled();
    });

    it("accepts a parent from the caller's project", async () => {
      const timelineRead: jest.Mock = mock(OWN_ID);

      await expect(
        create({ [`${kind}Id`]: new ObjectID(OWN_ID) }),
      ).resolves.toBeDefined();
      expect(timelineRead).toHaveBeenCalled();
    });
  },
);
