"""Enrich vault day notes with Garmin Connect health metrics.

Enrichment is idempotent: metrics live in the note's frontmatter, which has
replace semantics, so the same day can be re-run any number of times. That is
what makes backfilling arbitrary past dates safe, and it is why nothing here
ever appends to the note body.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
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

# Metrics off the endpoints that take a date range: one request covers the whole
# window, so these are cheap enough to refresh every few minutes.
RANGE_KEYS = (
    "body_battery_morning",
    "body_battery_min",
    "body_battery_max",
    "body_battery_charged",
    "body_battery_drained",
    "steps",
    "activity_minutes",
)

# Metrics that cost a request per day, because garminconnect exposes no range
# form for them. They also only change once a night, so a --fast run skips them.
DAILY_KEYS = (
    "sleep_start",
    "sleep_end",
    "sleep_hours",
    "resting_hr",
    "hrv_last_night",
)

BOOKKEEPING_KEYS = ("_garmin_synced", "_garmin_final")

MANAGED_KEYS = RANGE_KEYS + DAILY_KEYS + BOOKKEEPING_KEYS


@dataclass
class DayMetrics:
    """Metrics for one log day. Absent values stay None and are not written."""

    sleep_start: str | None = None
    sleep_end: str | None = None
    sleep_hours: float | None = None
    body_battery_morning: int | None = None
    body_battery_min: int | None = None
    body_battery_max: int | None = None
    body_battery_charged: int | None = None
    body_battery_drained: int | None = None
    resting_hr: int | None = None
    steps: int | None = None
    hrv_last_night: int | None = None

    # Deliberately not `training_minutes`, which the MCP server owns. The watch
    # cannot see a gym session done without it, and the bot cannot see a run, so
    # merging the two into one number would either double-count or overwrite.
    activity_minutes: int | None = None

    def as_frontmatter(self) -> dict[str, str]:
        values = {
            # Quoted: YAML 1.1 reads a bare 22:33 as a base-60 integer, and
            # Obsidian would show 1353 where the bedtime should be.
            "sleep_start": f'"{self.sleep_start}"' if self.sleep_start else None,
            "sleep_end": f'"{self.sleep_end}"' if self.sleep_end else None,
            "sleep_hours": self.sleep_hours,
            "body_battery_morning": self.body_battery_morning,
            "body_battery_min": self.body_battery_min,
            "body_battery_max": self.body_battery_max,
            "body_battery_charged": self.body_battery_charged,
            "body_battery_drained": self.body_battery_drained,
            "resting_hr": self.resting_hr,
            "steps": self.steps,
            "hrv_last_night": self.hrv_last_night,
            "activity_minutes": self.activity_minutes,
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
    # Both range endpoints answer with a list of day rows. A bare dict is
    # tolerated anyway: these endpoints are undocumented, and a single-day
    # response arriving unwrapped would otherwise read as no data at all.
    if not isinstance(rows, list):
        rows = [rows]

    indexed: dict[date, Any] = {}
    for row in rows:
        day = day_of(row)
        if day is not None:
            indexed[day] = row
    return indexed


def per_day(
    fetch: Callable[[str], Any], days: Sequence[date], *evidence: str
) -> dict[date, Any]:
    """Walk a span one date at a time, for endpoints with no range form.

    Only steps and Body Battery take a range; sleep and resting heart rate
    answer per date, so the window is walked. That is a request per day rather
    than per chunk, which is why nothing else is fetched that the sleep payload
    already carries.

    A payload carrying none of `evidence` is dropped rather than stored: a night
    the watch was off the wrist should read as an absent metric, not as a field
    this script failed to map.
    """
    indexed: dict[date, Any] = {}
    for day in days:
        payload = fetch(day.isoformat())
        if payload and (not evidence or pick(payload, *evidence) is not None):
            indexed[day] = payload
    return indexed


def rhr_row(payload: Any) -> Any:
    """Flatten the resting-heart-rate response to a plain row.

    The number sits three levels down, under a metric name and a single-element
    list, which `pick` deliberately does not reach — searching arbitrarily deep
    would make a wrong match as likely as a right one.
    """
    metrics = pick(payload, "metricsMap")
    rows = (
        metrics.get("WELLNESS_RESTING_HEART_RATE")
        if isinstance(metrics, dict)
        else None
    )
    return rows[0] if isinstance(rows, list) and rows else None


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


# Spelled out rather than taken from strftime("%A"): that follows the process
# locale, and on a host set to pl_PL the titles would come out "poniedziałek"
# while the rest of the vault is in English.
WEEKDAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)


def day_title(day: date) -> str:
    """`2026-08-17 · Monday · W34` — ISO weeks, so Sunday closes the week."""
    return (
        f"{day.isoformat()} · {WEEKDAYS[day.weekday()]} · W{day.isocalendar().week:02d}"
    )


def wall_clock(millis: Any) -> str | None:
    """HH:MM from Garmin's `...TimestampLocal` fields.

    Despite looking like an epoch, these are already shifted to the wearer's
    local time, so they are read as UTC. Interpreting them in Europe/Warsaw
    instead pushes every bedtime two hours later — 22:33 becomes 00:33, which is
    wrong but plausible enough to go unnoticed.
    """
    if not isinstance(millis, (int, float)) or isinstance(millis, bool):
        return None
    return datetime.fromtimestamp(millis / 1000, UTC).strftime("%H:%M")


def collect(
    client: Any,
    days: Sequence[date],
    *,
    fast: bool = False,
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

        window = [d for d in days if start <= d <= end]

        # A fast run touches only the range endpoints: one request each, however
        # wide the window. The per-day ones are what make a run expensive, and
        # what they measure changes once a night rather than through the day.
        sleep = (
            {} if fast else per_day(client.get_sleep_data, window, "sleepTimeSeconds")
        )
        rhr = (
            {}
            if fast
            else per_day(lambda d: rhr_row(client.get_rhr_day(d)), window, "value")
        )
        battery = index_by_day(client.get_body_battery(first, last))
        steps = index_by_day(client.get_daily_steps(first, last))

        for day in window:
            entry = metrics[day]

            if not fast:
                seconds = number([sleep], day, "sleep", "sleepTimeSeconds")
                if seconds is not None:
                    entry.sleep_hours = round(seconds / 3600, 1)

                entry.sleep_start = wall_clock(
                    pick(sleep.get(day), "sleepStartTimestampLocal")
                )
                entry.sleep_end = wall_clock(
                    pick(sleep.get(day), "sleepEndTimestampLocal")
                )

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

            walked = number([steps], day, "steps", "totalSteps")
            if walked is not None:
                entry.steps = int(walked)

            if not fast:
                # Resting heart rate covers the whole day, so it keeps its own
                # endpoint: a night the watch was off still has one, and falling
                # back to sleep alone would lose it.
                resting = number(
                    [rhr, sleep], day, "resting_hr", "value", "restingHeartRate"
                )
                if resting is not None:
                    entry.resting_hr = int(resting)

                # Overnight HRV comes off the sleep payload rather than the HRV
                # endpoint. Both report the same average, and Garmin only measures
                # it during sleep, so a separate request per day buys nothing.
                overnight = number([sleep], day, "hrv", "avgOvernightHrv")
                if overnight is not None:
                    entry.hrv_last_night = int(overnight)

    return metrics, unmapped, absent


@dataclass
class Activity:
    """One recorded workout, as the watch saw it."""

    sport: str
    seconds: float | None = None
    metres: float | None = None
    average_hr: int | None = None
    calories: int | None = None
    personal_record: bool = False


def whole(value: Any) -> int | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return round(value)


def as_activity(row: Any) -> Activity:
    kind = pick(row, "typeKey") or "activity"
    return Activity(
        sport=str(kind).replace("_", " ").title(),
        seconds=row.get("duration"),
        metres=row.get("distance"),
        average_hr=whole(row.get("averageHR")),
        calories=whole(row.get("calories")),
        personal_record=bool(row.get("isPR")),
    )


def collect_activities(client: Any, days: Sequence[date]) -> dict[date, list[Activity]]:
    """Recorded workouts per day.

    Kept apart from `collect`: the daily metrics describe a body, these describe
    what was done to it, and only the second belongs in a training log.
    """
    by_day: dict[date, list[Activity]] = {day: [] for day in days}

    for start, end in chunked(days):
        rows = client.get_activities_by_date(start.isoformat(), end.isoformat()) or []
        for row in rows:
            # The local start is what decides the day: a run at 23:40 belongs to
            # the evening it happened in, not to the UTC date it may fall under.
            stamp = row.get("startTimeLocal")
            if not isinstance(stamp, str):
                continue
            try:
                day = date.fromisoformat(stamp[:10])
            except ValueError:
                continue
            if day in by_day:
                by_day[day].append(as_activity(row))

    return by_day


def clock(seconds: float | None) -> str | None:
    """`28:52`, or `1:02:15` once it runs past the hour."""
    if seconds is None:
        return None

    total = round(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def pace(activity: Activity) -> str | None:
    """Minutes per kilometre, for anything that covered ground."""
    if not activity.seconds or not activity.metres:
        return None

    per_km = activity.seconds / (activity.metres / 1000)
    minutes, secs = divmod(round(per_km), 60)
    return f"{minutes}:{secs:02d} /km"


def activity_table(activities: Sequence[Activity]) -> str:
    """The day's workouts, dropping columns none of them filled in.

    A strength session records no distance and no pace. Carrying those columns
    anyway would read as data that went missing rather than as a different kind
    of session.
    """
    columns: list[tuple[str, Callable[[Activity], str | None]]] = [
        ("activity", lambda a: a.sport + (" · PR" if a.personal_record else "")),
        ("duration", lambda a: clock(a.seconds)),
        ("distance", lambda a: f"{a.metres / 1000:.2f} km" if a.metres else None),
        ("pace", pace),
        ("avg HR", lambda a: f"{a.average_hr} bpm" if a.average_hr else None),
        ("kcal", lambda a: str(a.calories) if a.calories else None),
    ]
    used = [
        (label, cell)
        for label, cell in columns
        if any(cell(activity) is not None for activity in activities)
    ]

    return "\n".join(
        [
            "| " + " | ".join(label for label, _ in used) + " |",
            "| " + " | ".join("---" for _ in used) + " |",
            *(
                "| " + " | ".join(cell(activity) or "—" for _, cell in used) + " |"
                for activity in activities
            ),
        ]
    )


def note_path(vault: Path, day: date) -> Path:
    return vault / "Daily" / f"{day.isoformat()}.md"


def session_path(vault: Path, day: date) -> Path:
    return vault / "Me" / "Training" / f"session-{day.isoformat()}.md"


def empty_session_note(day: date, title: str) -> str:
    return (
        "---\n"
        f"title: {day.isoformat()} – {title}\n"
        f"date: {day.isoformat()}\n"
        "tags:\n"
        "  - training\n"
        "---\n"
        "\n"
        "Related: [[Training]]\n"
    )


def replace_section(note: str, section: str, body: str) -> str:
    """Replace one `## section` block, appending it when the note has none.

    Everything outside the block is left alone. These notes also hold whatever
    was written by hand afterwards, and a re-run should not cost someone the
    paragraph they wrote about how the session felt.
    """
    lines = note.split("\n")
    heading = f"## {section}"

    if heading in lines:
        start = lines.index(heading)
        end = next(
            (
                index
                for index in range(start + 1, len(lines))
                if lines[index].startswith("## ")
            ),
            len(lines),
        )
        lines[start + 1 : end] = ["", *body.split("\n"), ""]
    else:
        while lines and not lines[-1].strip():
            lines.pop()
        lines.extend(["", heading, "", *body.split("\n")])

    return "\n".join(lines).rstrip("\n") + "\n"


def write_session(
    vault: Path, day: date, activities: Sequence[Activity], *, dry_run: bool
) -> bool:
    """Write the day's workouts into its session note. True when it changed.

    Unchanged notes are left untouched rather than rewritten with identical
    content: the vault is synced and committed on a timer, so a pointless write
    turns into a pointless commit.
    """
    if not activities:
        return False

    path = session_path(vault, day)
    title = ", ".join(dict.fromkeys(activity.sport for activity in activities))
    existing = existing_note(path)
    updated = replace_section(
        existing if existing is not None else empty_session_note(day, title),
        "Activities",
        activity_table(activities),
    )

    if updated == existing:
        return False
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(updated, encoding="utf8")
    return True


def empty_note(day: date) -> str:
    """Frontmatter only — the MCP server creates section headings on first use."""
    return (
        "---\n"
        f"title: {day_title(day)}\n"
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


def is_managed(line: str, managed: Sequence[str] = MANAGED_KEYS) -> bool:
    """True for a top-level key this run owns; indented list items are not."""
    if not line or line.startswith((" ", "-", "\t")):
        return False
    return line.split(":", 1)[0] in managed


def set_title(note: str, day: date) -> str:
    """Rewrites the title in place, so old notes pick up the new format.

    Kept out of MANAGED_KEYS on purpose: those get stripped and re-appended,
    which would drop the title to the bottom of the frontmatter.
    """
    return re.sub(r"^title: .*$", f"title: {day_title(day)}", note, count=1, flags=re.M)


def apply_frontmatter(
    note: str, updates: dict[str, str], managed: Sequence[str] = MANAGED_KEYS
) -> str:
    """Replace the keys this run owns, leaving every other line where it was.

    `managed` is narrowed on a fast run: those keys are stripped and rewritten
    from what was just fetched, so listing a key the run never asked about would
    quietly delete last night's sleep from the note.
    """
    lines, body = split_frontmatter(note)
    kept = [line for line in lines if not is_managed(line, managed)]
    kept.extend(f"{key}: {value}" for key, value in updates.items())
    return "---\n" + "\n".join(kept) + "\n---\n" + body


def existing_note(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf8")
    except FileNotFoundError:
        return None


def already_final(note: str) -> bool:
    lines, _ = split_frontmatter(note)
    return "_garmin_final: true" in lines


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
    fast: bool = False,
) -> str:
    path = note_path(vault, day)
    note = existing_note(path)

    if note is not None and already_final(note) and not force:
        return "skipped (already final)"
    if metrics.is_empty():
        return "no data"

    updates = metrics.as_frontmatter()

    # A fast run has not seen the whole day, so it never gets to call one final:
    # that flag stops every later run from looking, and it would freeze the note
    # without a single sleep figure in it.
    #
    # It leaves `_garmin_synced` alone too, and not to save a line. That value
    # changes on every run, which would make the unchanged-check below always
    # false and turn a five-minute timer into five-minute empty commits.
    if fast:
        managed: Sequence[str] = RANGE_KEYS
    else:
        managed = MANAGED_KEYS
        updates["_garmin_synced"] = datetime.now(TIMEZONE).isoformat(timespec="minutes")
        updates["_garmin_final"] = (
            "true" if is_settled(day, complete=complete) else "false"
        )

    updated = set_title(
        apply_frontmatter(
            note if note is not None else empty_note(day), updates, managed
        ),
        day,
    )

    # Unchanged notes are left alone rather than rewritten with identical
    # content: the vault is committed on a one-minute timer, and a fast run
    # every few minutes would otherwise fill the history with empty commits.
    if updated == note:
        return "unchanged"

    written = len(updates) - (0 if fast else 2)
    if dry_run:
        return f"would write {written} metrics"

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf8")
    return f"wrote {written} metrics" + ("" if note else " (new note)")


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
        "--fast",
        action="store_true",
        help="Only the range endpoints and activities: one request each, however "
        "wide the window. Skips sleep, resting heart rate and HRV, which cost a "
        "request per day and change once a night. Made for a frequent timer.",
    )
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

    client = connect(login=args.login)
    metrics, unmapped, absent = collect(client, days, fast=args.fast)
    activities = collect_activities(client, days)

    for day in days:
        recorded = activities[day]
        if recorded:
            metrics[day].activity_minutes = round(
                sum(activity.seconds or 0 for activity in recorded) / 60
            )

        outcome = write_day(
            vault,
            day,
            metrics[day],
            complete=not absent[day],
            force=args.force,
            dry_run=args.dry_run,
            fast=args.fast,
        )

        # Written whatever the day note decided: a day already marked final can
        # still gain a workout, since Garmin only sees an activity once the
        # watch has synced, which may be long after the day itself ended.
        if write_session(vault, day, recorded, dry_run=args.dry_run):
            verb = "would write" if args.dry_run else "wrote"
            count = f"{len(recorded)} activit" + ("y" if len(recorded) == 1 else "ies")
            outcome += f", {verb} {count} to session-{day}"

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
