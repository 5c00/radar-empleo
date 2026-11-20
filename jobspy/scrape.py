#!/usr/bin/env python3
"""Run JobSpy searches from a JSON config on stdin and print a JSON array on stdout."""

import json
import sys

MAX_DESCRIPTION = 2000


def as_text(value):
    if value is None:
        return ""
    text = str(value)
    return "" if text in ("nan", "NaT", "None", "<NA>") else text


def as_bool(value):
    if value is None:
        return False
    return str(value).strip().lower() in ("true", "1", "yes")


def main():
    try:
        config = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(f"invalid config: {exc}", file=sys.stderr)
        print("[]")
        return 1

    searches = config.get("searches") or []
    sites = config.get("sites") or ["indeed", "glassdoor"]
    results_wanted = int(config.get("resultsWanted", 20))
    hours_old = int(config.get("hoursOld", 72))
    country = config.get("country", "spain")

    try:
        from jobspy import scrape_jobs
    except Exception as exc:  # noqa: BLE001
        print(f"jobspy import failed: {exc}", file=sys.stderr)
        print("[]")
        return 1

    offers = []
    for search in searches:
        try:
            frame = scrape_jobs(
                site_name=sites,
                search_term=search,
                location="Spain",
                results_wanted=results_wanted,
                hours_old=hours_old,
                country_indeed=country,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"search '{search}' failed: {exc}", file=sys.stderr)
            continue

        try:
            records = frame.to_dict(orient="records")
        except Exception as exc:  # noqa: BLE001
            print(f"search '{search}' returned an unusable result: {exc}", file=sys.stderr)
            continue

        attrs = getattr(frame, "attrs", None)
        frame_errors = attrs.get("errors") if isinstance(attrs, dict) else None
        if frame_errors:
            print(f"search '{search}' reported errors: {frame_errors}", file=sys.stderr)

        for record in records:
            offers.append(
                {
                    "title": as_text(record.get("title")),
                    "company": as_text(record.get("company")),
                    "location": as_text(record.get("location")),
                    "job_url": as_text(record.get("job_url")),
                    "is_remote": as_bool(record.get("is_remote")),
                    "date_posted": as_text(record.get("date_posted")),
                    "description": as_text(record.get("description"))[:MAX_DESCRIPTION],
                }
            )

    print(json.dumps(offers, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
