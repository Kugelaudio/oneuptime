#!/usr/bin/env bash
# Proves the migration hook is keyed to the schema version through a real API
# server. `lookup` is always empty in helm-unittest and ordinary helm template.

# shellcheck source=../lib/harness.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/harness.sh"

NAMESPACE="${NAMESPACE:-oneuptime-migration-test}"
RELEASE="${RELEASE:-ou}"
SCHEMA_ID="12.0.24"
JOB_NAME="${RELEASE}-migrate-12-0-24"

harness_start_cluster
harness_namespace "$NAMESPACE"

kubectl -n "$NAMESPACE" delete job "$JOB_NAME" --ignore-not-found >/dev/null
kubectl -n "$NAMESPACE" create job "$JOB_NAME" --image=busybox:1.36 -- true >/dev/null
kubectl -n "$NAMESPACE" wait --for=condition=complete "job/$JOB_NAME" --timeout=120s >/dev/null

render() {
    helm template "$RELEASE" "$HELM_CHART_DIR" \
        --namespace "$NAMESPACE" \
        --dry-run=server \
        --set keda.enabled=false \
        --set migrate.hook=true \
        --set "migrate.id=$1"
}

SAME_SCHEMA_MANIFEST="$(render "$SCHEMA_ID")"
assert_absent \
    "a completed schema migration is omitted on the next release" \
    "$SAME_SCHEMA_MANIFEST" \
    "name: $JOB_NAME"

NEXT_SCHEMA_MANIFEST="$(render "12.1.0")"
assert_present \
    "a new schema identifier renders a new blocking migration" \
    "$NEXT_SCHEMA_MANIFEST" \
    "name: ${RELEASE}-migrate-12-1-0"

harness_report
