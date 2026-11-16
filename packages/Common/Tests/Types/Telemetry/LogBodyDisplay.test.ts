import { JSONObject } from "../../../Types/JSON";
import prepareLogBodyForDisplay, {
  DisplayLogBody,
} from "../../../Types/Telemetry/LogBodyDisplay";
import { describe, expect, test } from "@jest/globals";

/*
 * The Kubernetes agent ships k8sobjects records as a structured OTLP body,
 * which the ingest stores as the JSON encoding of the AnyValue wrapper. The
 * stored form has to stay as it is (the Kubernetes pages parse it back), so
 * the readability fix lives here, at display time. Ordinary string bodies
 * must pass through untouched.
 */

// Build an OTLP kvlist from a list of [key, valueWrapper] pairs.
function kvList(entries: Array<[string, JSONObject]>): JSONObject {
  return {
    values: entries.map(([key, value]: [string, JSONObject]) => {
      return { key, value };
    }),
  };
}

function watchEventBody(event: JSONObject): string {
  return JSON.stringify({
    kvlistValue: kvList([
      ["type", { stringValue: "ADDED" }],
      ["object", { kvlistValue: event }],
    ]),
  });
}

describe("prepareLogBodyForDisplay", () => {
  test("passes a plain text body through unchanged", () => {
    const prepared: DisplayLogBody = prepareLogBodyForDisplay(
      "Started TTS session 42",
    );

    expect(prepared.isJson).toBe(false);
    expect(prepared.pretty).toBe("Started TTS session 42");
    expect(prepared.compact).toBe("Started TTS session 42");
    expect(prepared.raw).toBe("Started TTS session 42");
  });

  test("handles an empty body", () => {
    const prepared: DisplayLogBody = prepareLogBodyForDisplay(undefined);

    expect(prepared.pretty).toBe("");
    expect(prepared.compact).toBe("");
    expect(prepared.raw).toBe("");
  });

  test("pretty-prints an ordinary JSON body without unwrapping anything", () => {
    const prepared: DisplayLogBody = prepareLogBodyForDisplay(
      '{"level":"error","msg":"boom"}',
    );

    expect(prepared.isJson).toBe(true);
    expect(prepared.compact).toBe('{"level":"error","msg":"boom"}');
    expect(prepared.pretty).toContain('"msg": "boom"');
  });

  test("renders an events.k8s.io/v1 event as one readable line", () => {
    const body: string = watchEventBody(
      kvList([
        ["kind", { stringValue: "Event" }],
        ["type", { stringValue: "Normal" }],
        ["reason", { stringValue: "ResourceUpdated" }],
        [
          "note",
          { stringValue: "Updated health status: Healthy -> Progressing" },
        ],
        [
          "regarding",
          {
            kvlistValue: kvList([
              ["kind", { stringValue: "Application" }],
              ["namespace", { stringValue: "argocd" }],
              ["name", { stringValue: "web-prod-kugel-eu-prod" }],
            ]),
          },
        ],
      ]),
    );

    const prepared: DisplayLogBody = prepareLogBodyForDisplay(body);

    expect(prepared.isJson).toBe(false);
    expect(prepared.pretty).toBe(
      "Normal ResourceUpdated Application argocd/web-prod-kugel-eu-prod: Updated health status: Healthy -> Progressing",
    );
    expect(prepared.compact).toBe(prepared.pretty);
    // The stored body is what a copy or an export must still produce.
    expect(prepared.raw).toBe(body);
  });

  test("reads the core/v1 message and involvedObject spelling", () => {
    const body: string = watchEventBody(
      kvList([
        ["kind", { stringValue: "Event" }],
        ["type", { stringValue: "Warning" }],
        ["reason", { stringValue: "BackOff" }],
        ["message", { stringValue: "Back-off restarting failed container" }],
        ["count", { intValue: "7" }],
        [
          "involvedObject",
          {
            kvlistValue: kvList([
              ["kind", { stringValue: "Pod" }],
              ["namespace", { stringValue: "backend" }],
              ["name", { stringValue: "tts-6d9f" }],
            ]),
          },
        ],
      ]),
    );

    expect(prepareLogBodyForDisplay(body).pretty).toBe(
      "Warning BackOff Pod backend/tts-6d9f: Back-off restarting failed container (x7)",
    );
  });

  test("reads a snake_case (protobufjs) encoded event", () => {
    const body: string = JSON.stringify({
      kvlist_value: kvList([
        ["type", { string_value: "MODIFIED" }],
        [
          "object",
          {
            kvlist_value: kvList([
              ["kind", { string_value: "Event" }],
              ["type", { string_value: "Normal" }],
              ["reason", { string_value: "Scheduled" }],
              ["note", { string_value: "Successfully assigned pod to node" }],
            ]),
          },
        ],
      ]),
    });

    expect(prepareLogBodyForDisplay(body).pretty).toBe(
      "Normal Scheduled: Successfully assigned pod to node",
    );
  });

  test("unwraps a non-event k8sobjects body instead of summarizing it", () => {
    const body: string = watchEventBody(
      kvList([
        ["kind", { stringValue: "Pod" }],
        [
          "metadata",
          {
            kvlistValue: kvList([
              ["name", { stringValue: "tts-6d9f" }],
              ["namespace", { stringValue: "backend" }],
            ]),
          },
        ],
      ]),
    );

    const prepared: DisplayLogBody = prepareLogBodyForDisplay(body);

    expect(prepared.isJson).toBe(true);
    // No OTLP wrapper keys survive into what the viewer shows.
    expect(prepared.compact).not.toContain("kvlistValue");
    expect(prepared.compact).not.toContain("stringValue");
    expect(prepared.compact).toBe(
      '{"type":"ADDED","object":{"kind":"Pod","metadata":{"name":"tts-6d9f","namespace":"backend"}}}',
    );
  });

  test("falls back to the unwrapped object when an event carries no reason or note", () => {
    const body: string = watchEventBody(
      kvList([
        ["kind", { stringValue: "Event" }],
        ["type", { stringValue: "Normal" }],
      ]),
    );

    const prepared: DisplayLogBody = prepareLogBodyForDisplay(body);

    expect(prepared.isJson).toBe(true);
    expect(prepared.compact).toBe(
      '{"type":"ADDED","object":{"kind":"Event","type":"Normal"}}',
    );
  });
});
