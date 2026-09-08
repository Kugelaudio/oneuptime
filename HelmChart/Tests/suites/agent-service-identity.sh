#!/usr/bin/env bash
# Service identity is independent of Deployment/release names; no cluster needed.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/harness.sh"

harness_install_helm
args=(identity "$KUBERNETES_AGENT_CHART_DIR" --namespace oneuptime-agent
    --set clusterName=identity-test --set oneuptime.url=https://example.invalid
    --set oneuptime.apiKey=test --show-only templates/configmap-daemonset.yaml)

default_config="$(helm template "${args[@]}")"
configured="$(helm template "${args[@]}" \
    --set-string serviceNames.backend.tts=kugelaudio-tts \
    --set-string serviceNames.backend.normalizer=kugelaudio-normalizer)"

assert_absent "defaults preserve upstream service identities" "$default_config" "kugelaudio-tts"
assert_eq "both log and metric resources use the stable TTS name" 2 \
    "$(awk '/set\(.*service.name.*kugelaudio-tts/{n++} END{print n+0}' <<<"$configured")"
assert_eq "both log and metric resources use the stable normalizer name" 2 \
    "$(awk '/set\(.*service.name.*kugelaudio-normalizer/{n++} END{print n+0}' <<<"$configured")"
assert_present "deployment identity remains available" "$configured" 'k8s.deployment.name'

if helm template "${args[@]}" --set-string serviceNames.backend.tts= >/dev/null 2>&1; then
    fail "empty service names must fail rendering"
else
    pass "empty service names fail rendering"
fi

harness_report
