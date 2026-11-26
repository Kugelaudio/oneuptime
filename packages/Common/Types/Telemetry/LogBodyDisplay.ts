import { JSONObject } from "../JSON";
import { kvListToPlainObject } from "../Kubernetes/KubernetesObjectParser";

/*
 * ============================================================
 * Log body presentation
 * ============================================================
 *
 * Most log records arrive with a string body and are displayed verbatim.
 * The Kubernetes agent's k8sobjects receiver instead sends a structured
 * body, which the log ingest stores as the JSON encoding of the OTLP
 * AnyValue wrapper:
 *
 *   {"kvlistValue":{"values":[{"key":"type","value":{"stringValue":"ADDED"}} ...
 *
 * That wrapper is stored on purpose: the Kubernetes pages parse it back
 * into objects (see KubernetesObjectParser). It is unreadable in a log
 * viewer, so the viewer unwraps it for display only, and renders a
 * Kubernetes event as the one line `kubectl get events` would show.
 */

export interface DisplayLogBody {
  /** True when `pretty` is JSON and should render in a JSON block. */
  isJson: boolean;
  /** Multi-line text for a details panel. */
  pretty: string;
  /** Single-line text for a table row. */
  compact: string;
  /** The stored body, unchanged, for copy and export. */
  raw: string;
}

type PlainObject = Record<string, unknown>;

/**
 * Unwrap an OTLP AnyValue-encoded body into plain JSON. Returns null when
 * the body is not an AnyValue wrapper, which is every ordinary log.
 */
function unwrapOTelBody(parsed: unknown): PlainObject | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const body: JSONObject = parsed as JSONObject;

  // Both encodings are on the wire: camelCase (JSON) and snake_case (protobufjs).
  const kvList: JSONObject | undefined = (body["kvlistValue"] ||
    body["kvlist_value"]) as JSONObject | undefined;

  if (!kvList) {
    return null;
  }

  return kvListToPlainObject(kvList);
}

function asObject(value: unknown): PlainObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as PlainObject;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Pick the Kubernetes Event out of an unwrapped k8sobjects body. In watch
 * mode the record is `{ type: "ADDED", object: <event> }`; in pull mode the
 * event is at the top level.
 */
function getKubernetesEvent(unwrapped: PlainObject): PlainObject | null {
  const watched: PlainObject | null = asObject(unwrapped["object"]);
  const candidate: PlainObject = watched || unwrapped;

  if (asString(candidate["kind"]) !== "Event") {
    return null;
  }

  return candidate;
}

/**
 * Render a Kubernetes Event as one line, in the order `kubectl get events`
 * uses. Returns null when the record carries neither a reason nor a message,
 * so the caller falls back to showing the object.
 */
function summarizeKubernetesEvent(event: PlainObject): string | null {
  const reason: string = asString(event["reason"]);

  /*
   * events.k8s.io/v1 spells these `note` and `regarding`; the core/v1 Event
   * it supersedes spells them `message` and `involvedObject`. Both reach us,
   * because which one an agent watches depends on the cluster.
   */
  const note: string = asString(event["note"]) || asString(event["message"]);

  if (!reason && !note) {
    return null;
  }

  const regarding: PlainObject | null =
    asObject(event["regarding"]) || asObject(event["involvedObject"]);

  const parts: Array<string> = [];

  // "Normal" / "Warning".
  const eventType: string = asString(event["type"]);
  if (eventType) {
    parts.push(eventType);
  }

  if (reason) {
    parts.push(reason);
  }

  if (regarding) {
    const kind: string = asString(regarding["kind"]);
    const name: string = asString(regarding["name"]);
    const namespace: string = asString(regarding["namespace"]);
    const qualifiedName: string =
      namespace && name ? `${namespace}/${name}` : name;

    if (kind) {
      parts.push(kind);
    }
    if (qualifiedName) {
      parts.push(qualifiedName);
    }
  }

  const count: unknown = event["count"] ?? event["deprecatedCount"];
  const repeats: number = typeof count === "number" ? count : Number(count);
  const countSuffix: string =
    Number.isFinite(repeats) && repeats > 1 ? ` (x${repeats})` : "";

  const heading: string = parts.join(" ");

  if (!note) {
    return `${heading}${countSuffix}`;
  }

  return heading
    ? `${heading}: ${note}${countSuffix}`
    : `${note}${countSuffix}`;
}

/**
 * Turn a stored log body into what a viewer should show. Non-JSON bodies are
 * returned unchanged; this never rewrites what is stored or searched.
 */
export default function prepareLogBodyForDisplay(
  body: string | undefined,
): DisplayLogBody {
  const raw: string = body || "";

  if (!raw) {
    return { isJson: false, pretty: "", compact: "", raw: "" };
  }

  let parsed: unknown = null;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { isJson: false, pretty: raw, compact: raw, raw };
  }

  const unwrapped: PlainObject | null = unwrapOTelBody(parsed);

  if (unwrapped) {
    const event: PlainObject | null = getKubernetesEvent(unwrapped);
    const summary: string | null = event
      ? summarizeKubernetesEvent(event)
      : null;

    if (summary) {
      return { isJson: false, pretty: summary, compact: summary, raw };
    }

    return {
      isJson: true,
      pretty: JSON.stringify(unwrapped, null, 2),
      compact: JSON.stringify(unwrapped),
      raw,
    };
  }

  return {
    isJson: true,
    pretty: JSON.stringify(parsed, null, 2),
    compact: JSON.stringify(parsed),
    raw,
  };
}
