#!/usr/bin/env python3
"""Print a read-only usage overview of the Cloud Run service `xml-online-viewer`.

Sources (both via gcloud credentials, no writes):
  * Cloud Monitoring `run.googleapis.com/request_count` — totals, per-day
    counts and response-code classes (cheap, exact).
  * Cloud Logging request logs — breakdown of `/api/*` calls by method + path
    (capped by --limit; scanner noise like /api/.env is listed separately).

Requires: gcloud (authenticated, access to project xml-viewer-online).

Usage:
    python3 tools/usage_report.py                 # last 30 days
    python3 tools/usage_report.py --days 7
    python3 tools/usage_report.py --no-logs       # metrics only (fast)
    python3 tools/usage_report.py --limit 20000   # scan more log entries
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

GCP_PROJECT = "xml-viewer-online"
SERVICE = "xml-online-viewer"
METRIC = "run.googleapis.com/request_count"

# Paths that exist in backend/app/api; everything else under /api/ is scanner noise.
KNOWN_API_PREFIXES = (
    "/api/xml/",
    "/api/xsd/",
    "/api/validate",
    "/api/fundsxml/",
    "/api/feedback",
    "/api/health",
    "/api/report",
)


def gcloud(*args: str) -> str:
    return subprocess.check_output(["gcloud", *args, "--project", GCP_PROJECT], text=True)


def access_token() -> str:
    return subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()


def query_metric(token: str, start: dt.datetime, end: dt.datetime, group_by: str | None):
    params = {
        "filter": f'metric.type="{METRIC}" AND resource.labels.service_name="{SERVICE}"',
        "interval.startTime": start.isoformat(),
        "interval.endTime": end.isoformat(),
        "aggregation.alignmentPeriod": "86400s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
    }
    if group_by:
        params["aggregation.groupByFields"] = group_by
    url = f"https://monitoring.googleapis.com/v3/projects/{GCP_PROJECT}/timeSeries?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp).get("timeSeries", [])
    except urllib.error.HTTPError as e:
        sys.exit(f"Monitoring API error {e.code}: {e.read().decode()}")


def print_table(rows: list[tuple], headers: tuple[str, ...]) -> None:
    if not rows:
        print("(no rows)")
        return
    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) for i, h in enumerate(headers)]
    print("  ".join(str(h).ljust(w) for h, w in zip(headers, widths)))
    for r in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))


def metrics_section(days: int) -> None:
    token = access_token()
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=days)

    per_day: collections.Counter[str] = collections.Counter()
    for ts in query_metric(token, start, end, None):
        for pt in ts["points"]:
            per_day[pt["interval"]["endTime"][:10]] += int(pt["value"]["int64Value"])
    total = sum(per_day.values())

    by_class: collections.Counter[str] = collections.Counter()
    for ts in query_metric(token, start, end, "metric.labels.response_code_class"):
        cls = ts["metric"].get("labels", {}).get("response_code_class", "?")
        by_class[cls] += sum(int(p["value"]["int64Value"]) for p in ts["points"])

    print(f"### Total requests: {total}")
    if per_day:
        vals = sorted(per_day.values())
        print(f"    per day: min {vals[0]}, median {vals[len(vals) // 2]}, max {vals[-1]}")
    print("\n### Per day")
    print_table(sorted(per_day.items()), ("day", "requests"))
    print("\n### Response code class")
    print_table(sorted(by_class.items()), ("class", "requests"))


def logs_section(days: int, limit: int) -> None:
    flt = (
        f'resource.type="cloud_run_revision" AND resource.labels.service_name="{SERVICE}" '
        'AND httpRequest.requestUrl:"/api/"'
    )
    out = gcloud(
        "logging", "read", flt, f"--freshness={days}d", f"--limit={limit}",
        "--format=value(httpRequest.requestMethod,httpRequest.requestUrl,httpRequest.status)",
    )
    known: collections.Counter[tuple[str, str]] = collections.Counter()
    noise: collections.Counter[str] = collections.Counter()
    statuses: collections.Counter[str] = collections.Counter()
    errors: list[tuple[str, str, str]] = []
    n = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        method, url, status = parts[:3]
        path = re.sub(r"^https?://[^/]+", "", url).split("?")[0]
        # collapse release version in path
        path_key = re.sub(r"/releases/[^/]+/", "/releases/<ver>/", path)
        n += 1
        statuses[status] += 1
        if path.startswith(KNOWN_API_PREFIXES):
            known[(method, path_key)] += 1
            if status.startswith("5"):
                errors.append((method, path, status))
        else:
            noise[path] += 1

    print(f"\n### API calls from request logs (scanned {n} entries, limit {limit})")
    if n >= limit:
        print(f"    WARNING: hit --limit={limit}; counts below are truncated")
    print("\n#### Real endpoints")
    print_table([(c, m, p) for (m, p), c in known.most_common()], ("n", "method", "path"))
    print(f"\n#### Scanner / unknown paths ({sum(noise.values())} total, top 15)")
    print_table([(c, p) for p, c in noise.most_common(15)], ("n", "path"))
    print("\n#### HTTP status of API calls")
    print_table(sorted(statuses.items()), ("status", "n"))
    if errors:
        print("\n#### 5xx on real endpoints")
        print_table(errors, ("method", "path", "status"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=30, help="look-back window (default 30)")
    ap.add_argument("--limit", type=int, default=5000, help="max log entries to scan (default 5000)")
    ap.add_argument("--no-logs", action="store_true", help="skip the Cloud Logging API breakdown")
    args = ap.parse_args()

    print(f"XML Online Viewer — Cloud Run usage ({SERVICE}, last {args.days} days)\n")
    metrics_section(args.days)
    if not args.no_logs:
        logs_section(args.days, args.limit)


if __name__ == "__main__":
    main()
