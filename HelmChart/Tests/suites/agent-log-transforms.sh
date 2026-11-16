#!/usr/bin/env bash
# Optional pod-log OTTL runs before severity filtering, never on other signals.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/harness.sh"

harness_install_helm
args=(log-transforms "$KUBERNETES_AGENT_CHART_DIR" --namespace oneuptime-agent
    --set clusterName=log-test --set oneuptime.url=https://example.invalid
    --set oneuptime.apiKey=test --show-only templates/configmap-daemonset.yaml)
fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
cat >"$fixture" <<'YAML'
filters:
  logs:
    minSeverity: WARN
logs:
  transformStatements:
    - 'set(severity_number, SEVERITY_NUMBER_INFO) where body == "expected state"'
    - 'set(severity_text, "INFO") where body == "expected state"'
YAML

defaults="$(helm template "${args[@]}")"
configured="$(helm template "${args[@]}" -f "$fixture")"
assert_absent "default pipeline has no transformation" "$defaults" "transform/pod_logs"
assert_present "configured statements are rendered" "$configured" 'where body == "expected state"'
assert_present "runtime errors retain the log" "$configured" 'error_mode: ignore'
assert_eq "only pod logs invoke the processor" 1 \
    "$(awk '/- transform\/pod_logs/{n++} END{print n+0}' <<<"$configured")"
order="$(awk '/^      pipelines:/{pipelines=1} pipelines && /^        logs:/{logs=1} logs && /- (k8sattributes|transform\/pod_logs|filter\/telemetry)/{print $2}' <<<"$configured")"
assert_eq "metadata then correction then severity filter" \
    $'k8sattributes\ntransform/pod_logs\nfilter/telemetry' "$order"

for mode in api disabled; do
    if helm template "${args[@]}" -f "$fixture" --set logs.mode="$mode" >/dev/null 2>&1; then
        fail "statements with $mode mode must fail rendering"
    else
        pass "statements with $mode mode fail rendering"
    fi
done
if helm template "${args[@]}" -f "$fixture" --set logs.windowsPods.enabled=true >/dev/null 2>&1; then
    fail "statements with hybrid Windows tailing must fail rendering"
else
    pass "statements with hybrid Windows tailing fail rendering"
fi
if helm template "${args[@]}" --set-json 'logs.transformStatements=[true]' >/dev/null 2>&1; then
    fail "non-string statements must fail schema validation"
else
    pass "non-string statements fail schema validation"
fi
if [ -n "${AGENT_LOG_VALUES:-}" ]; then
    uv run --no-project --with pyyaml python \
        "$(dirname "${BASH_SOURCE[0]}")/agent-log-transforms.py" --values "$AGENT_LOG_VALUES"
    pass "shipping Collector replay preserves genuine failure severity"
fi
harness_report
