"""Replay HAProxy log fixtures through the shipping Collector 0.96.0 binary."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

import yaml

parser = argparse.ArgumentParser()
parser.add_argument("--baseline", action="store_true")
parser.add_argument("--values", type=Path, required=True)
args = parser.parse_args()
chart = Path(__file__).resolve().parents[2] / "Public/kubernetes-agent"
render = subprocess.run([
    "helm", "template", "log-fixtures", str(chart), "--namespace", "oneuptime-agent",
    "--set", "clusterName=fixture", "-f", str(args.values),
    "--show-only", "templates/configmap-daemonset.yaml",
], check=True, capture_output=True, text=True)
rendered = yaml.safe_load(render.stdout)
agent_config = yaml.safe_load(rendered["data"]["otel-collector-config.yaml"])
pipeline = agent_config["service"]["pipelines"]["logs"]["processors"]
assert pipeline.index("k8sattributes") < pipeline.index("transform/pod_logs") < pipeline.index("filter/telemetry")
assert "transform/pod_logs" not in agent_config["service"]["pipelines"]["metrics"]["processors"]
helper = "[ALERT]    (8) : backend 'check_if_redis_is_master_{}' has no server available!"
fixtures = [("haproxy", helper.format(i), 9) for i in range(3)] + [
    ("haproxy", "[ALERT]    (8) : backend 'bk_redis_master' has no server available!", 21),
    ("haproxy", "[ALERT]    (8) : backend 'bk_redis_slave' has no server available!", 21),
    ("redis", helper.format(0), 21),
    ("haproxy", "[ALERT]    (8) : parsing [/etc/haproxy.cfg:10] : unknown keyword", 21),
    ("haproxy", helper.format(0) + " extra failure", 21),
    ("haproxy", "prefix " + helper.format(0), 21),
    ("haproxy", {"message": helper.format(0)}, 21),
    ("", helper.format(0), 21),
    ("haproxy", helper.format(0), 21),
    ("haproxy", helper.format(1), 9),
]
with tempfile.TemporaryDirectory(prefix="valkey-log-regression-") as temporary:
    work = Path(temporary)
    work.chmod(0o777)
    (work / "input.log").write_text("".join(json.dumps({"case": str(i), "container": container, "deployment": "unrelated-haproxy" if i == 11 else "kugelaudio-valkey-ha-haproxy" if i == 12 else "platform-kv-haproxy", "message": body, "severity": "fatal"}) + "\n" for i, (container, body, _) in enumerate(fixtures)))
    config = {
        "receivers": {"filelog": {
            "include": ["/work/input.log"], "start_at": "beginning", "poll_interval": "100ms",
            "operators": [
                {"type": "json_parser"},
                {"type": "move", "from": "attributes.container", "to": 'resource["k8s.container.name"]'},
                {"type": "move", "from": "attributes.deployment", "to": 'resource["k8s.deployment.name"]'},
                {"type": "move", "from": "attributes.message", "to": "body"},
                {"type": "severity_parser", "parse_from": "attributes.severity"},
            ],
        }},
        "processors": {} if args.baseline else {"transform/pod_logs": agent_config["processors"]["transform/pod_logs"]},
        "exporters": {"file": {"path": "/work/output.json", "flush_interval": "100ms"}},
        "service": {"pipelines": {"logs": {"receivers": ["filelog"], "processors": [] if args.baseline else ["transform/pod_logs"], "exporters": ["file"]}}},
    }
    (work / "config.yaml").write_text(yaml.safe_dump(config))
    container_name = "valkey-log-test-" + uuid.uuid4().hex[:10]
    command = ["docker", "run", "--rm", "--name", container_name, "-v", f"{work}:/work", "otel/opentelemetry-collector-contrib:0.96.0", "--config=/work/config.yaml"]
    with (work / "collector.log").open("w") as output:
        process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT)
        try:
            records = {}
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError((work / "collector.log").read_text())
                if (work / "output.json").exists():
                    for line in (work / "output.json").read_text().splitlines():
                        try:
                            batch = json.loads(line)
                        except json.JSONDecodeError:
                            continue  # file exporter may be midway through its final line
                        for resource in batch.get("resourceLogs", []):
                            for scope in resource["scopeLogs"]:
                                for record in scope["logRecords"]:
                                    key = next(a["value"]["stringValue"] for a in record["attributes"] if a["key"] == "case")
                                    records[key] = record
                if len(records) == len(fixtures):
                    break
                time.sleep(0.1)
            assert len(records) == len(fixtures), (len(records), (work / "collector.log").read_text())
            for i, (_, body, expected) in enumerate(fixtures):
                record = records[str(i)]
                assert record["severityNumber"] == expected, (i, record, expected)
                if isinstance(body, str):
                    assert record["body"] == {"stringValue": body}, record
                if expected == 9:
                    assert record["severityText"] == "INFO", record
            logs = (work / "collector.log").read_text()
            assert "failed to execute" not in logs.lower(), logs
            print(f"PASS: {len(fixtures)} Collector 0.96.0 fixtures; helper=9/INFO, main backend=21/FATAL, control records unchanged")
        finally:
            subprocess.run(["docker", "stop", "--time", "2", container_name], capture_output=True, timeout=10)
            process.wait(timeout=10)
