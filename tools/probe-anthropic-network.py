import concurrent.futures
import collections
import datetime
import json
import os
import pathlib
import statistics
import subprocess
import threading
import time

vantage = os.environ.get("PROBE_VANTAGE", "local")
duration = int(os.environ.get("PROBE_SECONDS", "180"))
interval = float(os.environ.get("PROBE_INTERVAL", "1"))
start_at = float(os.environ.get("PROBE_START_AT", "0")) or time.time()
if not 1 <= duration <= 600:
    raise ValueError("PROBE_SECONDS must be between 1 and 600")
if not 1 <= interval <= 60:
    raise ValueError("PROBE_INTERVAL must be between 1 and 60 seconds")
if time.time() - start_at > 30:
    raise RuntimeError("Scheduled start was missed; rerun both vantages together")
print(json.dumps({"type": "scheduled", "vantage": vantage, "start_at": start_at, "seconds": duration, "interval": interval}), flush=True)
time.sleep(max(0, start_at - time.time()))
started_at = time.time()
deadline = time.monotonic() + duration
format_string = '{"http":"%{http_code}","peer":"%{remote_ip}","dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"total":%{time_total}}'
base = ["curl", "--disable", "--ipv4", "--http1.1", "--noproxy", "*", "--connect-timeout", "4", "--max-time", "6", "-sS", "-o", "/dev/null", "-w", format_string]
if os.environ.get("PROBE_INTERFACE"):
    base += ["--interface", os.environ["PROBE_INTERFACE"]]
targets = [("anthropic-dns", "https://api.anthropic.com/", [])] * 2 + [("anthropic-pinned", "https://api.anthropic.com/", ["--resolve", "api.anthropic.com:443:160.79.104.10"])] * 2 + [("openai-control", "https://api.openai.com/v1/models", [])]
records = []
output_lock = threading.Lock()
print(json.dumps({"type": "started", "vantage": vantage, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "curl": subprocess.run(["curl", "--version"], check=True, capture_output=True, text=True).stdout.splitlines()[0]}), flush=True)


def lane(number, target, url, options):
    while time.monotonic() < deadline:
        at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")
        response = subprocess.run(base + options + [url], capture_output=True, text=True, timeout=10)
        timings = json.loads(response.stdout)
        timings["http"] = int(timings["http"])
        ok = response.returncode == 0 and timings["http"] > 0
        phase = "response"
        if not ok:
            phase = "tcp-connect" if timings["connect"] == 0 else "tls-handshake" if timings["tls"] == 0 else "http-response"
        record = {"type": "sample", "vantage": vantage, "target": target, "lane": number, "at": at, "ok": ok, "exit": response.returncode, "phase": phase, **timings}
        if response.stderr.strip():
            record["error"] = response.stderr.strip()
        with output_lock:
            records.append(record)
            print(json.dumps(record), flush=True)
        time.sleep(interval)


with concurrent.futures.ThreadPoolExecutor(max_workers=len(targets)) as pool:
    futures = [pool.submit(lane, number, *target) for number, target in enumerate(targets)]
    for future in futures:
        future.result()

summaries = []
for target in dict.fromkeys(target[0] for target in targets):
    selected = [record for record in records if record["target"] == target]
    failures = [record for record in selected if not record["ok"]]
    connect_times = [record["connect"] - record["dns"] for record in selected if record["connect"] > 0]
    summary = {"type": "summary", "vantage": vantage, "target": target, "started_at": started_at, "finished_at": time.time(), "samples": len(selected), "failures": len(failures), "failed_phases": dict(collections.Counter(record["phase"] for record in failures)), "statuses": dict(collections.Counter(str(record["http"]) for record in selected)), "peers": sorted({record["peer"] for record in selected if record["peer"]}), "max_total_seconds": max(record["total"] for record in selected), "median_tcp_seconds": statistics.median(connect_times) if connect_times else None, "max_tcp_seconds": max(connect_times) if connect_times else None, "tcp_over_one_second": sum(value > 1 for value in connect_times)}
    summaries.append(summary)
    print(json.dumps(summary), flush=True)

if os.environ.get("GITHUB_STEP_SUMMARY"):
    lines = ["## Fresh IPv4 connection comparison", "", f"Vantage: {vantage}", "", "| Target | Samples | Failures | Slow TCP handshakes (>1 s) |", "| --- | ---: | ---: | ---: |"]
    lines += [f"| {record['target']} | {record['samples']} | {record['failures']} | {record['tcp_over_one_second']} |" for record in summaries]
    with pathlib.Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write("\n".join(lines) + "\n")
raise SystemExit(int(any(not record["ok"] for record in records)))
