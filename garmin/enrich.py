"""Enrich vault day notes with Garmin Connect health metrics.

Enrichment is idempotent: metrics live in the note's frontmatter, which has
replace semantics, so the same day can be re-run any number of times. That is
what makes backfilling arbitrary past dates safe, and it is why nothing here
ever appends to the note body.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TIMEZONE = ZoneInfo("Europe/Warsaw")

# Mirrors the MCP server: the log day rolls over at 04:00, so a day only counts
# as complete once the *following* day's rollover has passed.
ROLLOVER_HOUR = 4

# Garmin's range endpoints are undocumented and have been observed to truncate
# long spans, so requests are chunked conservatively rather than optimistically.
CHUNK_DAYS = 28

# How long an incomplete day stays worth re-fetching. Long enough to survive a
# holiday without syncing the watch, short enough that a day which genuinely
# never recorded a metric stops being retried.
SETTLE_DAYS = 10

MANAGED_KEYS = (
    "sleep_hours",
    "body_battery_morning",
    "body_battery_min",
    "body_battery_max",
    "body_battery_charged",
    "body_battery_drained",
    "resting_hr",
    "steps",
    "hrv_last_night",
    "garmin_synced",
    "garmin_final",
)


@dataclass
class DayMetrics:
    """Metrics for one log day. Absent values stay None and are not written."""

    sleep_hours: float | None = None
    body_battery_morning: int | None = None
    body_battery_min: int | None = None
    body_battery_max: int | None = None
    body_battery_charged: int | None = None
    body_battery_drained: int | None = None
    resting_hr: int | None = None
    steps: int | None = None
    hrv_last_night: int | None = None

    def as_frontmatter(self) -> dict[str, str]:
        values = {
            "sleep_hours": self.sleep_hours,
            "body_battery_morning": self.body_battery_morning,
            "body_battery_min": self.body_battery_min,
            "body_battery_max": self.body_battery_max,
            "body_battery_charged": self.body_battery_charged,
            "body_battery_drained": self.body_battery_drained,
            "resting_hr": self.resting_hr,
            "steps": self.steps,
            "hrv_last_night": self.hrv_last_night,
        }
        return {key: str(value) for key, value in values.items() if value is not None}

    def is_empty(self) -> bool:
        return not self.as_frontmatter()


@dataclass
class UnmappedField:
    """A metric the API returned in a shape this script did not recognise."""

    day: date
    metric: str
    available_keys: list[str] = field(default_factory=list)


def log_day_is_final(day: date, now: datetime | None = None) -> bool:
    now = now or datetime.now(TIMEZONE)
    ends_at = datetime.combine(day + timedelta(days=1), datetime.min.time(), TIMEZONE)
    return now >= ends_at.replace(hour=ROLLOVER_HOUR)


def chunked(
    days: Sequence[date], size: int = CHUNK_DAYS
) -> Iterator[tuple[date, date]]:
    for start in range(0, len(days), size):
        window = days[start : start + size]
        yield window[0], window[-1]


def pick(payload: Any, *names: str) -> Any:
    """First present value among `names`, searched one level into nested dicts.

    Garmin nests the same metric differently per endpoint (sometimes directly,
    sometimes under a `values` or `...DTO` object), so this tolerates both
    rather than hard-coding one shape.
    """
    if not isinstance(payload, dict):
        return None

    for name in names:
        if payload.get(name) is not None:
            return payload[name]

    for value in payload.values():
        if isinstance(value, dict):
            for name in names:
                if value.get(name) is not None:
                    return value[name]
    return None


def payload_keys(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return [type(payload).__name__]

    keys = list(payload.keys())
    for key, value in payload.items():
        if isinstance(value, dict):
            keys.extend(f"{key}.{nested}" for nested in value)
    return keys


def day_of(payload: Any) -> date | None:
    raw = pick(payload, "calendarDate", "date", "statisticsStartDate")
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def index_by_day(rows: Any) -> dict[date, Any]:
    # Not every endpoint returns a bare list: HRV wraps its days in an object.
    # Unwrapping here rather than at the call site keeps a container shape from
    # looking like an absent metric, which is a far more misleading failure.
    if isinstance(rows, dict) and day_of(rows) is None:
        for value in rows.values():
            if isinstance(value, list):
                rows = value
                break

    if not isinstance(rows, list):
        rows = [rows]

    indexed: dict[date, Any] = {}
    for row in rows:
        day = day_of(row)
        if day is not None:
            indexed[day] = row
    return indexed


def level_column(row: Any) -> int:
    """Which column of a Body Battery sample holds the level.

    Garmin describes the tuple layout in a sibling `...DescriptorDTOList` rather
    than fixing it, so the column is looked up by name. Index 2 is the layout
    seen in practice and stays as the fallback.
    """
    descriptors = (
        row.get("bodyBatteryValueDescriptorDTOList") if isinstance(row, dict) else None
    )
    if isinstance(descriptors, list):
        for descriptor in descriptors:
            if not isinstance(descriptor, dict):
                continue
            key = str(descriptor.get("bodyBatteryValueDescriptorKey", "")).lower()
            position = descriptor.get("bodyBatteryValueDescriptorIndex")
            if "level" in key and isinstance(position, int):
                return position
    return 2


def body_battery_levels(row: Any) -> list[int]:
    """Body Battery arrives as a timeseries; the frontmatter keeps its shape."""
    series = pick(row, "bodyBatteryValuesArray", "bodyBatteryValues")
    if not isinstance(series, list):
        return []

    column = level_column(row)
    levels: list[int] = []
    for sample in series:
        value: Any = None
        if isinstance(sample, list) and len(sample) > column:
            value = sample[column]
        elif isinstance(sample, dict):
            value = pick(sample, "bodyBatteryLevel", "level")
        if isinstance(value, (int, float)):
            levels.append(int(value))
    return levels


def collect(
    client: Any,
    days: Sequence[date],
) -> tuple[dict[date, DayMetrics], list[UnmappedField], dict[date, set[str]]]:
    metrics: dict[date, DayMetrics] = {day: DayMetrics() for day in days}
    unmapped: list[UnmappedField] = []

    # Tracked per day, not merely counted: whether a day is worth fetching again
    # depends on what that particular day is still missing.
    absent: dict[date, set[str]] = {day: set() for day in days}

    def number(
        sources: Sequence[dict[date, Any]], day: date, metric: str, *names: str
    ) -> float | None:
        """Read one numeric field, distinguishing 'no data' from 'wrong shape'.

        A metric the API simply did not return is not a mapping error — the watch
        was off the wrist, or the day has not settled yet. Counting those apart
        keeps a real shape mismatch visible instead of buried in noise.

        Several sources may carry the same number (resting heart rate arrives on
        both the dedicated endpoint and the sleep payload), so they are tried in
        order and the metric only counts as missing when none of them has a row.
        """
        rows = [row for source in sources if (row := source.get(day)) is not None]
        for row in rows:
            value = pick(row, *names)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)

        # Only the dedicated endpoint is evidence of a mapping error. A fallback
        # payload not carrying the field is ordinary, and reporting it as a shape
        # mismatch would bury the real ones.
        primary = sources[0].get(day)
        if primary is None:
            absent[day].add(metric)
        else:
            unmapped.append(UnmappedField(day, metric, payload_keys(primary)))
        return None

    for start, end in chunked(days):
        first, last = start.isoformat(), end.isoformat()
        print(f"garmin: fetching {first} … {last}", file=sys.stderr)

        sleep = index_by_day(client.get_sleep_daily(first, last))
        battery = index_by_day(client.get_body_battery(first, last))
        rhr = index_by_day(client.get_rhr_daily(first, last))
        steps = index_by_day(client.get_daily_steps(first, last))
        hrv = index_by_day(client.get_hrv_data_range(first, last))

        for day in (d for d in days if start <= d <= end):
            entry = metrics[day]

            seconds = number(
                [sleep], day, "sleep", "totalSleepTimeInSeconds", "sleepTimeSeconds"
            )
            if seconds is not None:
                entry.sleep_hours = round(seconds / 3600, 1)

            # The range endpoint sometimes carries only the daily summary, so the
            # timeseries is optional and charged/drained are recorded either way.
            levels = body_battery_levels(battery.get(day))
            if levels:
                entry.body_battery_morning = levels[0]
                entry.body_battery_min = min(levels)
                entry.body_battery_max = max(levels)

            charged = number([battery], day, "body_battery_charged", "charged")
            if charged is not None:
                entry.body_battery_charged = int(charged)

            # Garmin reports drainage as a negative number; the note keeps it as
            # a magnitude so the two Body Battery figures read side by side.
            drained = number([battery], day, "body_battery_drained", "drained")
            if drained is not None:
                entry.body_battery_drained = abs(int(drained))

            resting = number(
                [rhr, sleep],
                day,
                "resting_hr",
                "value",
                "restingHR",
                "restingHeartRate",
            )
            if resting is not None:
                entry.resting_hr = int(resting)

            walked = number([steps], day, "steps", "totalSteps", "steps")
            if walked is not None:
                entry.steps = int(walked)

            overnight = number(
                [hrv], day, "hrv", "lastNightAvg", "lastNight5MinHigh", "weeklyAvg"
            )
            if overnight is not None:
                entry.hrv_last_night = int(overnight)

    return metrics, unmapped, absent


def note_path(vault: Path, day: date) -> Path:
    return vault / "Daily" / f"{day.isoformat()}.md"


def empty_note(day: date) -> str:
    """Frontmatter only — the MCP server creates section headings on first use."""
    return (
        "---\n"
        f"title: {day.isoformat()}\n"
        f"date: {day.isoformat()}\n"
        "tags:\n"
        "  - daily\n"
        "kcal: 0\n"
        "---\n"
        "\n"
        "Related: [[Diet]], [[Training]]\n"
    )


def split_frontmatter(note: str) -> tuple[list[str], str]:
    if not note.startswith("---\n"):
        raise ValueError("day note is missing its frontmatter fence")

    closing = note.index("\n---\n", 3)
    return note[4:closing].split("\n"), note[closing + 5 :]


def is_managed(line: str) -> bool:
    """True for a top-level key this script owns; indented list items are not."""
    if not line or line.startswith((" ", "-", "\t")):
        return False
    return line.split(":", 1)[0] in MANAGED_KEYS


def apply_frontmatter(note: str, updates: dict[str, str]) -> str:
    lines, body = split_frontmatter(note)
    kept = [line for line in lines if not is_managed(line)]
    kept.extend(f"{key}: {value}" for key, value in updates.items())
    return "---\n" + "\n".join(kept) + "\n---\n" + body


def existing_note(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf8")
    except FileNotFoundError:
        return None


def already_final(note: str) -> bool:
    lines, _ = split_frontmatter(note)
    return "garmin_final: true" in lines


def is_settled(day: date, *, complete: bool, now: datetime | None = None) -> bool:
    """Whether a day will never be worth fetching again.

    A finished day is not the same as a finished record: if the watch had not
    synced when the timer ran, some metrics are simply not there yet, and a day
    marked final on elapsed time alone would keep those holes forever.

    The escape hatch is age. Garmin does not backfill weeks later, so past the
    settle window an incomplete day is accepted as incomplete rather than
    re-fetched on every run for the rest of time.
    """
    if not log_day_is_final(day, now):
        return False
    if complete:
        return True

    today = (now or datetime.now(TIMEZONE)).date()
    return (today - day).days > SETTLE_DAYS


def write_day(
    vault: Path,
    day: date,
    metrics: DayMetrics,
    *,
    complete: bool,
    force: bool,
    dry_run: bool,
) -> str:
    path = note_path(vault, day)
    note = existing_note(path)

    if note is not None and already_final(note) and not force:
        return "skipped (already final)"
    if metrics.is_empty():
        return "no data"

    settled = is_settled(day, complete=complete)
    updates = metrics.as_frontmatter()
    updates["garmin_synced"] = datetime.now(TIMEZONE).isoformat(timespec="minutes")
    updates["garmin_final"] = "true" if settled else "false"

    updated = apply_frontmatter(note if note is not None else empty_note(day), updates)
    if dry_run:
        return f"would write {len(updates) - 2} metrics"

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf8")
    return f"wrote {len(updates) - 2} metrics" + ("" if note else " (new note)")


def resolve_days(args: argparse.Namespace) -> list[date]:
    if args.date:
        return [date.fromisoformat(args.date)]
    if args.since:
        start = date.fromisoformat(args.since)
        end = (
            date.fromisoformat(args.until)
            if args.until
            else datetime.now(TIMEZONE).date()
        )
        if end < start:
            raise SystemExit("--until precedes --since")
        return [
            start + timedelta(days=offset) for offset in range((end - start).days + 1)
        ]

    today = datetime.now(TIMEZONE).date()
    return [today - timedelta(days=offset) for offset in range(args.days - 1, -1, -1)]


def token_store() -> str:
    return str(Path(os.environ.get("GARMIN_TOKENS", "~/.garminconnect")).expanduser())


def connect(*, login: bool) -> Any:
    """Resume a cached Garmin session, or start one under --login.

    Accounts with MFA cannot be logged into unattended, and Garmin rate-limits
    the login endpoints by IP — two of the three strategies answer 429 after a
    handful of attempts. So a normal run never touches credentials: it either
    resumes from the token cache or fails and says how to create one.
    """
    from garminconnect import Garmin  # imported lazily so --help works without it

    tokens = token_store()

    if not login:
        client = Garmin()
        try:
            client.login(tokens)
        except Exception as error:
            raise SystemExit(
                f"No usable Garmin session in {tokens} ({error}).\n"
                "Run this once, interactively, to create one:\n"
                "  GARMIN_EMAIL=... GARMIN_PASSWORD=... enrich.py --login"
            ) from error
        return client

    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")
    if not email or not password:
        raise SystemExit("GARMIN_EMAIL and GARMIN_PASSWORD are required for --login")

    client = Garmin(email, password, prompt_mfa=lambda: input("Garmin MFA code: "))
    client.login(tokens)
    print(f"garmin: session cached in {tokens}", file=sys.stderr)
    return client


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", help="Enrich exactly this YYYY-MM-DD")
    parser.add_argument("--since", help="Start of a YYYY-MM-DD range")
    parser.add_argument("--until", help="End of the range; defaults to today")
    parser.add_argument(
        "--days", type=int, default=2, help="Trailing days to enrich (default: 2)"
    )
    parser.add_argument(
        "--force", action="store_true", help="Re-fetch days already marked final"
    )
    parser.add_argument("--dry-run", action="store_true", help="Report without writing")
    parser.add_argument(
        "--login",
        action="store_true",
        help="Log in with credentials and cache the session; prompts for the MFA code",
    )
    args = parser.parse_args(argv)

    vault = Path(
        os.environ.get("VAULT_PATH", Path(__file__).resolve().parent.parent / "docs")
    )
    days = resolve_days(args)
    print(f"garmin: {len(days)} day(s), vault {vault}", file=sys.stderr)

    metrics, unmapped, absent = collect(connect(login=args.login), days)

    for day in days:
        outcome = write_day(
            vault,
            day,
            metrics[day],
            complete=not absent[day],
            force=args.force,
            dry_run=args.dry_run,
        )
        print(f"  {day}  {outcome}")

    missing: Counter[str] = Counter(
        metric for metrics_missing in absent.values() for metric in metrics_missing
    )
    if missing:
        summary = ", ".join(
            f"{metric} ({count})" for metric, count in sorted(missing.items())
        )
        print(f"\ngarmin: no data returned for {summary}", file=sys.stderr)
        print(
            "Those days stay open and are re-fetched until they settle.",
            file=sys.stderr,
        )

    if unmapped:
        print(
            f"\ngarmin: {len(unmapped)} field(s) returned in an unrecognised shape:",
            file=sys.stderr,
        )
        for miss in unmapped[:10]:
            print(
                f"  {miss.day} {miss.metric}: {', '.join(miss.available_keys[:12])}",
                file=sys.stderr,
            )
        print("Map these keys in pick() and re-run.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
