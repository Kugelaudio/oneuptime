import Dictionary from "Common/Types/Dictionary";
import InBetween from "Common/Types/BaseDatabase/InBetween";
import Includes from "Common/Types/BaseDatabase/Includes";
import ObjectID from "Common/Types/ObjectID";
import Query from "Common/Types/BaseDatabase/Query";
import ExceptionInstance from "Common/Models/AnalyticsModels/ExceptionInstance";
import TelemetryException from "Common/Models/DatabaseModels/TelemetryException";

/*
 * Attribute facet scope for the Exceptions list.
 *
 * TelemetryException (the Postgres group row) deliberately has no
 * attributes column — attributes live on the ClickHouse ExceptionInstance
 * rows. An `attributes.<key>` chip therefore compiles as a two-step,
 * client-side cross-store join (the pattern ExceptionsTable already uses
 * for entity scope): (1) one instance query with EVERY attribute filter
 * ANDed + the time window, grouped by fingerprint; (2) the resulting
 * fingerprints narrow the Postgres list and ride the histogram/facets
 * payloads (both already accept `fingerprints`).
 */

export const EXCEPTION_ATTRIBUTE_FACET_PREFIX: string = "attributes.";

/*
 * Sentinel injected when the attribute scope matched no instances — an
 * impossible fingerprint that forces an empty list instead of silently
 * showing the UNFILTERED list.
 */
export const NO_MATCH_FINGERPRINT: string = "__attribute-scope-no-match__";

/*
 * Cap on the fingerprints carried into the Postgres IN() — same bound
 * ExceptionsTable uses for its entity-scope join.
 */
export const MAX_SCOPED_FINGERPRINTS: number = 10_000;

/*
 * `@fingerprint:<value>` addresses one exception GROUP by its identity —
 * it is how the span and session-replay panels deep-link to a group. It
 * has to count as a real column: as an unknown token it resolved as an
 * `attributes.fingerprint` lookup on the instance rows, matched nothing,
 * and every deep link landed on an empty list.
 */
export const EXCEPTION_FINGERPRINT_SEARCH_FIELD: string = "fingerprint";

/*
 * Search fields the exceptions backend can filter as real columns; any
 * OTHER `@key:value` search token is an instance attribute.
 */
export const KNOWN_EXCEPTION_SEARCH_FIELDS: Array<string> = [
  "exceptionType",
  "primaryEntityId",
  "environment",
  EXCEPTION_FINGERPRINT_SEARCH_FIELD,
];

/** attributeKey -> selected values (chip order preserved). */
export type ExceptionAttributeSelections = Dictionary<Array<string>>;

export function isExceptionAttributeFacetKey(facetKey: string): boolean {
  return (
    facetKey.startsWith(EXCEPTION_ATTRIBUTE_FACET_PREFIX) &&
    facetKey.length > EXCEPTION_ATTRIBUTE_FACET_PREFIX.length
  );
}

/**
 * Pull the attribute selections out of grouped facet values + parsed
 * search field filters. Facet keys carry the `attributes.` prefix (only
 * the FIRST prefix strips — dots in the key survive); search keys are
 * bare and count as attributes when they are not known backend fields.
 */
export function getExceptionAttributeSelections(input: {
  facetGroups: Record<string, Array<string>>;
  searchFieldFilters: Record<string, Array<string>>;
}): ExceptionAttributeSelections {
  const selections: ExceptionAttributeSelections = {};

  const addValues: (attributeKey: string, values: Array<string>) => void = (
    attributeKey: string,
    values: Array<string>,
  ): void => {
    const cleanValues: Array<string> = values.filter(
      (value: string): boolean => {
        return typeof value === "string" && value.trim() !== "";
      },
    );
    if (attributeKey.trim() === "" || cleanValues.length === 0) {
      return;
    }
    if (!selections[attributeKey]) {
      selections[attributeKey] = [];
    }
    for (const value of cleanValues) {
      if (!selections[attributeKey]!.includes(value)) {
        selections[attributeKey]!.push(value);
      }
    }
  };

  for (const facetKey of Object.keys(input.facetGroups)) {
    if (!isExceptionAttributeFacetKey(facetKey)) {
      continue;
    }
    addValues(
      facetKey.slice(EXCEPTION_ATTRIBUTE_FACET_PREFIX.length),
      input.facetGroups[facetKey] || [],
    );
  }

  for (const fieldKey of Object.keys(input.searchFieldFilters)) {
    if (KNOWN_EXCEPTION_SEARCH_FIELDS.includes(fieldKey)) {
      continue;
    }
    addValues(fieldKey, input.searchFieldFilters[fieldKey] || []);
  }

  return selections;
}

export function hasExceptionAttributeSelections(
  selections: ExceptionAttributeSelections,
): boolean {
  return Object.keys(selections).length > 0;
}

/**
 * Stable identity of one attribute-scope resolution — the effect uses it
 * to pair a resolved fingerprint set with the selections+window that
 * produced it (and to skip stale responses).
 */
export function getExceptionAttributeScopeKey(input: {
  selections: ExceptionAttributeSelections;
  windowStartMs: number;
  windowEndMs: number;
}): string {
  const orderedSelections: Record<string, Array<string>> = {};
  for (const key of Object.keys(input.selections).sort()) {
    orderedSelections[key] = [...(input.selections[key] || [])].sort();
  }
  return JSON.stringify([
    orderedSelections,
    input.windowStartMs,
    input.windowEndMs,
  ]);
}

/**
 * The single ClickHouse instance query resolving the scope: every
 * attribute filter ANDs on the SAME instance (a chip on `http.method`
 * and one on `host` match instances carrying both), bounded to the
 * viewer's window.
 */
export function buildExceptionInstanceAttributeQuery(input: {
  projectId: ObjectID;
  window: InBetween<Date>;
  selections: ExceptionAttributeSelections;
}): Query<ExceptionInstance> {
  const attributes: Dictionary<string | Includes> = {};

  for (const attributeKey of Object.keys(input.selections)) {
    const values: Array<string> = input.selections[attributeKey] || [];
    if (values.length === 1) {
      attributes[attributeKey] = values[0] as string;
    } else if (values.length > 1) {
      attributes[attributeKey] = new Includes(values);
    }
  }

  return {
    projectId: input.projectId,
    time: input.window,
    attributes,
  } as Query<ExceptionInstance>;
}

/**
 * The one fingerprint set the list, histogram and facets all narrow to.
 * Two things can produce it: an explicit `@fingerprint:` token (a group
 * deep link) and a resolved attribute scope. Null means neither is
 * active, so nothing narrows. With both active the sets INTERSECT —
 * honouring only one of them would widen the view past what was asked
 * for. An attribute scope still resolving counts as "matched nothing"
 * yet, same as before: an empty array, which the caller turns into the
 * no-match sentinel rather than a flash of the unfiltered list.
 */
export function resolveExceptionFingerprintScope(input: {
  explicitFingerprints: Array<string>;
  attributeScopeActive: boolean;
  resolvedAttributeFingerprints: Array<string> | null;
}): Array<string> | null {
  const explicit: Array<string> = input.explicitFingerprints
    .filter((value: string): boolean => {
      return typeof value === "string" && value.trim() !== "";
    })
    .map((value: string): string => {
      return value.trim();
    });

  if (!input.attributeScopeActive) {
    return explicit.length > 0 ? explicit : null;
  }

  const resolved: Array<string> = input.resolvedAttributeFingerprints || [];

  if (explicit.length === 0) {
    return resolved;
  }

  const allowed: Set<string> = new Set<string>(explicit);
  return resolved.filter((fingerprint: string): boolean => {
    return allowed.has(fingerprint);
  });
}

/**
 * Narrow the Postgres list query to the resolved fingerprints. An empty
 * resolution injects the no-match sentinel — the scope matched nothing,
 * and the list must say so rather than quietly widening.
 */
export function applyExceptionFingerprintScope(
  query: Query<TelemetryException>,
  fingerprints: Array<string>,
): void {
  const scoped: Array<string> =
    fingerprints.length > 0
      ? fingerprints.slice(0, MAX_SCOPED_FINGERPRINTS)
      : [NO_MATCH_FINGERPRINT];
  (query as Record<string, unknown>)["fingerprint"] = new Includes(scoped);
}
