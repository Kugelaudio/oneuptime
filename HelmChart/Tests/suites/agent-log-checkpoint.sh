#!/usr/bin/env bash
# Pod-log offsets survive an agent restart and new files are read from their
# first byte; no cluster needed (ENG-2031).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/harness.sh"

harness_install_helm
args=(ckpt "$KUBERNETES_AGENT_CHART_DIR" --namespace oneuptime-agent
    --set clusterName=ckpt-test --set oneuptime.url=https://example.invalid
    --set oneuptime.apiKey=test)
cm=(--show-only templates/configmap-daemonset.yaml)
ds=(--show-only templates/daemonset.yaml)

default_config="$(helm template "${args[@]}" "${cm[@]}")"
default_ds="$(helm template "${args[@]}" "${ds[@]}")"
assert_absent "defaults keep no storage extension" "$default_config" "file_storage/pod_logs"
assert_present "defaults keep start_at end" "$default_config" "start_at: end"
assert_absent "defaults mount no checkpoint volume" "$default_ds" "checkpoint"

ckpt=(--set logs.checkpoint.enabled=true)
ckpt_config="$(helm template "${args[@]}" "${cm[@]}" "${ckpt[@]}")"
ckpt_ds="$(helm template "${args[@]}" "${ds[@]}" "${ckpt[@]}")"
assert_present "checkpoint declares the storage extension" "$ckpt_config" "file_storage/pod_logs:"
assert_eq "checkpoint enables the extension in the service" 1 \
    "$(awk '/^      extensions:/{f=1;next} f&&/- file_storage\/pod_logs/{n++} f&&/^      pipelines:/{f=0} END{print n+0}' <<<"$ckpt_config")"
assert_eq "the pod-log receiver stores its offsets" 1 \
    "$(awk '/^      filelog:/{f=1;next} f&&/storage: file_storage\/pod_logs/{n++} f&&/^      [a-z]/{f=0} END{print n+0}' <<<"$ckpt_config")"
assert_present "the offsets directory is a hostPath" "$ckpt_ds" "/var/lib/otelcol-kubernetes-agent"
assert_present "the offsets directory is mounted writable" "$ckpt_ds" "name: log-checkpoint"

beginning=(--set logs.checkpoint.enabled=true --set logs.startAt=beginning)
beginning_config="$(helm template "${args[@]}" "${cm[@]}" "${beginning[@]}")"
assert_present "startAt beginning reaches the pod-log receiver" "$beginning_config" "start_at: beginning"
assert_absent "startAt beginning replaces end for pod logs" \
    "$(awk '/^      filelog:/{f=1} f' <<<"$beginning_config" | head -40)" "start_at: end"

if helm template "${args[@]}" --set logs.startAt=beginning >/dev/null 2>&1; then
    fail "start_at beginning without a checkpoint must fail rendering"
else
    pass "start_at beginning without a checkpoint fails rendering"
fi
if helm template "${args[@]}" --set logs.startAt=middle >/dev/null 2>&1; then
    fail "an unknown startAt must fail rendering"
else
    pass "an unknown startAt fails rendering"
fi

harness_report
