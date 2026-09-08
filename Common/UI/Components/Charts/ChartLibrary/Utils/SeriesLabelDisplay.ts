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
 * A value can be shared by every series too — a chart filtered to one cluster
 * and one model splits only on revision — and a value that is the same on
 * every row tells the rows apart no better than the key does. Those pairs are
 * printed once as `key=value` beside the keys, so a row wraps onto a second
 * line only when something on it actually varies.
 *
 * Nothing here is applied unless EVERY name on the chart parses into the same
 * key sequence: a chart whose series are plain names ("Failed generations"),
 * or one whose names disagree, renders exactly as before. A chart with a
 * single series keeps every key and value on its row: with nothing to tell
 * apart, hoisting would leave the row empty.
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
  /**
   * The keys the rows still carry values for, in order, or null when the
   * names were left untouched.
   */
  keyHeader: string | null;
  /**
   * `key=value` for every attribute whose value is the same on every series,
   * printed once above the rows; null when every attribute varies.
   */
  constantHeader: string | null;
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
    constantHeader: null,
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

  const parsedNames: Array<ParsedSeriesName> = Array.from(
    parsedByName.values(),
  );
  const firstValues: Array<string> = parsedNames[0]!.values;

  /*
   * An attribute whose value never differs cannot tell two rows apart, so it
   * is printed once with its key instead of on every row. Indexes are kept
   * in group-by order on both sides, which is the order the reader already
   * learned from the chart's legend.
   */
  const varyingIndexes: Array<number> = [];
  const constantIndexes: Array<number> = [];

  sharedKeys.forEach((_key: string, index: number) => {
    const isConstant: boolean = parsedNames.every(
      (parsed: ParsedSeriesName) => {
        return parsed.values[index] === firstValues[index];
      },
    );

    (isConstant ? constantIndexes : varyingIndexes).push(index);
  });

  /*
   * One series, or several that differ only by the previous-period suffix:
   * every value is "constant", and hoisting them all would leave each row
   * with nothing on it. Keep the pre-existing shape instead.
   */
  const hoistedIndexes: Array<number> =
    varyingIndexes.length > 0 ? constantIndexes : [];
  const rowIndexes: Array<number> =
    varyingIndexes.length > 0
      ? varyingIndexes
      : sharedKeys.map((_key: string, index: number) => {
          return index;
        });

  const labels: Map<string, string> = new Map<string, string>();

  for (const [category, parsed] of parsedByName) {
    labels.set(
      category,
      rowIndexes
        .map((index: number) => {
          return parsed.values[index]!;
        })
        .join(SERIES_LABEL_SEPARATOR) + parsed.suffix,
    );
  }

  return {
    keyHeader: rowIndexes
      .map((index: number) => {
        return sharedKeys![index]!;
      })
      .join(SERIES_LABEL_SEPARATOR),
    constantHeader:
      hoistedIndexes.length > 0
        ? hoistedIndexes
            .map((index: number) => {
              return `${sharedKeys![index]}=${firstValues[index]}`;
            })
            .join(SERIES_LABEL_SEPARATOR)
        : null,
    labels,
  };
}
