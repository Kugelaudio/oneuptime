import { describe, expect, test } from "@jest/globals";
import {
  SeriesLabelDisplay,
  getSeriesLabelDisplay,
} from "../../../../UI/Components/Charts/ChartLibrary/Utils/SeriesLabelDisplay";
import { PREVIOUS_PERIOD_SERIES_SUFFIX } from "../../../../UI/Components/Charts/ChartLibrary/Utils/TooltipEntries";

/*
 * A dashboard chart grouped by attributes names each series after the whole
 * group, so every tooltip row repeats the attribute keys before the first
 * character that tells the rows apart. These pin the compression that lifts
 * the keys into a single header, and — more importantly — the cases where it
 * must NOT run, because a wrong header would mislabel every row.
 */

describe("getSeriesLabelDisplay", () => {
  test("lifts the shared keys out of grouped series names", () => {
    const display: SeriesLabelDisplay = getSeriesLabelDisplay([
      "resource.k8s.cluster.name=kugel-eu-prod, deployment=web, state=desired",
      "resource.k8s.cluster.name=kugelaudio-prod-us-west-2, deployment=ingress, state=available",
    ]);

    expect(display.keyHeader).toBe(
      "resource.k8s.cluster.name · deployment · state",
    );
    expect(display.constantHeader).toBeNull();
    expect(
      display.labels.get(
        "resource.k8s.cluster.name=kugel-eu-prod, deployment=web, state=desired",
      ),
    ).toBe("kugel-eu-prod · web · desired");
    expect(
      display.labels.get(
        "resource.k8s.cluster.name=kugelaudio-prod-us-west-2, deployment=ingress, state=available",
      ),
    ).toBe("kugelaudio-prod-us-west-2 · ingress · available");
  });

  test("prints a value shared by every series once instead of on every row", () => {
    const display: SeriesLabelDisplay = getSeriesLabelDisplay([
      "resource.k8s.cluster.name=kugel-eu-prod, revision=67998f55c, model_key=kugel-3, transport=http",
      "resource.k8s.cluster.name=kugel-eu-prod, revision=67998f55c, model_key=kugel-3, transport=websocket",
      "resource.k8s.cluster.name=kugel-eu-prod, revision=6dfdf79dc, model_key=kugel-3, transport=http",
    ]);

    /*
     * Cluster and model are the same on all three rows, so they cannot tell
     * them apart; what remains is short enough to stay on one line.
     */
    expect(display.constantHeader).toBe(
      "resource.k8s.cluster.name=kugel-eu-prod · model_key=kugel-3",
    );
    expect(display.keyHeader).toBe("revision · transport");
    expect(
      display.labels.get(
        "resource.k8s.cluster.name=kugel-eu-prod, revision=6dfdf79dc, model_key=kugel-3, transport=http",
      ),
    ).toBe("6dfdf79dc · http");
  });

  test("keeps the hoisted pairs and the row values in group-by order", () => {
    const display: SeriesLabelDisplay = getSeriesLabelDisplay([
      "a=1, b=shared, c=2, d=also-shared",
      "a=3, b=shared, c=4, d=also-shared",
    ]);

    expect(display.constantHeader).toBe("b=shared · d=also-shared");
    expect(display.keyHeader).toBe("a · c");
    expect(display.labels.get("a=3, b=shared, c=4, d=also-shared")).toBe(
      "3 · 4",
    );
  });

  test("keeps every value on the row when a single series makes them all constant", () => {
    const name: string = "cluster=eu, deployment=web, state=available";

    const display: SeriesLabelDisplay = getSeriesLabelDisplay([name]);

    expect(display.constantHeader).toBeNull();
    expect(display.keyHeader).toBe("cluster · deployment · state");
    expect(display.labels.get(name)).toBe("eu · web · available");
  });

  test("keeps the compare-to-previous-period marker on the row", () => {
    const name: string = `cluster=eu, state=available${PREVIOUS_PERIOD_SERIES_SUFFIX}`;

    const display: SeriesLabelDisplay = getSeriesLabelDisplay([
      "cluster=eu, state=available",
      name,
    ]);

    expect(display.keyHeader).toBe("cluster · state");
    expect(display.labels.get(name)).toBe(
      `eu · available${PREVIOUS_PERIOD_SERIES_SUFFIX}`,
    );
  });

  test("keeps a value that itself contains an equals sign", () => {
    const display: SeriesLabelDisplay = getSeriesLabelDisplay([
      "cluster=eu, selector=app=web",
    ]);

    expect(display.labels.get("cluster=eu, selector=app=web")).toBe(
      "eu · app=web",
    );
  });

  test.each([
    ["a plain series name", ["Failed generations", "cluster=eu, state=up"]],
    ["a single grouped attribute", ["deployment=web", "deployment=ingress"]],
    ["a segment without a key", ["cluster=eu, state=up", "cluster=eu, up"]],
    ["an empty key", ["=eu, state=up"]],
    [
      "series grouped by different attributes",
      ["cluster=eu, state=up", "cluster=eu, phase=running"],
    ],
    ["no series at all", []],
  ])("leaves names untouched for %s", (_name: string, categories: string[]) => {
    const display: SeriesLabelDisplay = getSeriesLabelDisplay(categories);

    expect(display.keyHeader).toBeNull();
    expect(display.constantHeader).toBeNull();
    expect(display.labels.size).toBe(0);
  });
});
