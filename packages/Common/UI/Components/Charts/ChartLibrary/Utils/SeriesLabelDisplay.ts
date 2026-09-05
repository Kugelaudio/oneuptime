/*
 * Readable row labels for grouped-metric tooltips.
 *
 * A chart grouped by attributes names every series after the whole group:
 * "resource.k8s.cluster.name=kugel-eu-prod, deployment=web, state=available"
 * (see the group-by splitter in the dashboard's metric charts). Every row of
 * the tooltip then repeats the same attribute keys before reaching the first
 * character that tells the rows apart, and the row grows wide enough that the
 * value — the reason the tooltip exists — is pushed outside the card.
 *
 * The keys are identical for every series on such a chart, so print them once
 * as a tooltip subtitle and let each row carry only its values.
 *
 * Nothing here is applied unless EVERY name on the chart parses into the same
 * key sequence: a chart whose series are plain names ("Failed generations"),
 * or one whose names disagree, renders exactly as before.
 */

import { PREVIOUS_PERIOD_SERIES_SUFFIX } from "./TooltipEntries";

/** Separator between the printed keys, and between a row's values. */
export const SERIES_LABEL_SEPARATOR: string = " · ";

/** How grouped series names join their `key=value` segments. */
const SERIES_NAME_SEGMENT_SEPARATOR: string = ", ";

/*
 * A one-attribute group-by ("deployment=web") is already short, and its key
 * is worth keeping on the row. Compress only from two attributes up, which is
 * where the repeated prefix starts costing more than it explains.
 */
const MINIMUM_COMPRESSIBLE_SEGMENTS: number = 2;

export interface SeriesLabelDisplay {
  /** The shared keys, in order, or null when the names were left untouched. */
  keyHeader: string | null;
  /** Series name -> row text. A name absent from the map renders unchanged. */
  labels: Map<string, string>;
}

interface ParsedSeriesName {
  keys: Array<string>;
  values: Array<string>;
  /** The compare-to-previous-period marker, kept on the rendered label. */
  suffix: string;
}

/*
 * "key=value, key=value" -> keys and values. Splits each segment on its FIRST
 * "=" so a value may contain one; returns null for any name that is not a
 * complete list of non-empty keys, which is what makes an ungrouped chart opt
 * out on its own.
 */
function parseSeriesName(name: string): ParsedSeriesName | null {
  const suffix: string = name.endsWith(PREVIOUS_PERIOD_SERIES_SUFFIX)
    ? PREVIOUS_PERIOD_SERIES_SUFFIX
    : "";
  const base: string = suffix ? name.slice(0, -suffix.length) : name;

  const segments: Array<string> = base.split(SERIES_NAME_SEGMENT_SEPARATOR);

  if (segments.length < MINIMUM_COMPRESSIBLE_SEGMENTS) {
    return null;
  }

  const keys: Array<string> = [];
  const values: Array<string> = [];

  for (const segment of segments) {
    const separatorIndex: number = segment.indexOf("=");

    if (separatorIndex <= 0) {
      return null;
    }

    keys.push(segment.slice(0, separatorIndex));
    values.push(segment.slice(separatorIndex + 1));
  }

  return { keys, values, suffix };
}

/**
 * Compute the row labels for one chart's series names.
 *
 * Pass every series on the chart, not just the entries that survived the
 * tooltip's entry cap: the label of a given series must not change shape as
 * the pointer moves between timestamps.
 */
export function getSeriesLabelDisplay(
  categories: Array<string>,
): SeriesLabelDisplay {
  const unchanged: SeriesLabelDisplay = {
    keyHeader: null,
    labels: new Map<string, string>(),
  };

  if (categories.length === 0) {
    return unchanged;
  }

  let sharedKeys: Array<string> | null = null;
  const parsedByName: Map<string, ParsedSeriesName> = new Map<
    string,
    ParsedSeriesName
  >();

  for (const category of categories) {
    if (parsedByName.has(category)) {
      continue;
    }

    const parsed: ParsedSeriesName | null = parseSeriesName(category);

    if (!parsed) {
      return unchanged;
    }

    if (!sharedKeys) {
      sharedKeys = parsed.keys;
    } else if (
      sharedKeys.length !== parsed.keys.length ||
      sharedKeys.some((key: string, index: number) => {
        return key !== parsed.keys[index];
      })
    ) {
      /*
       * Different attributes per series: no single key list describes the
       * chart, so every row keeps its own keys.
       */
      return unchanged;
    }

    parsedByName.set(category, parsed);
  }

  if (!sharedKeys) {
    return unchanged;
  }

  const labels: Map<string, string> = new Map<string, string>();

  for (const [category, parsed] of parsedByName) {
    labels.set(
      category,
      parsed.values.join(SERIES_LABEL_SEPARATOR) + parsed.suffix,
    );
  }

  return { keyHeader: sharedKeys.join(SERIES_LABEL_SEPARATOR), labels };
}
