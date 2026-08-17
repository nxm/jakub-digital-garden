# Garmin enrichment

Attaches Garmin Connect health metrics to vault day notes. It is enrichment,
not capture: the MCP server records what you ate and thought during the day,
and this fills in what your watch already knew.

## Why it is re-runnable

Metrics live in the note's **frontmatter**, which has replace semantics, so a
day can be enriched any number of times. Nothing here ever appends to the note
body. That is what makes arbitrary backfill safe — a month you never logged
gets its notes created from health data alone, and a gap left by a failed run
is closed by simply running it again.

```shell
python enrich.py                                  # yesterday and today
python enrich.py --days 7                         # trailing week
python enrich.py --since 2026-07-01 --until 2026-07-31
python enrich.py --date 2026-08-10 --force
python enrich.py --days 30 --dry-run
```

## Partial days

A day enriched at 14:00 has incomplete steps and Body Battery. Each note
records whether the day had fully elapsed when it was fetched:

```yaml
garmin_synced: 2026-08-18T05:12+02:00
garmin_final: true
```

Days marked `garmin_final: true` are skipped on later runs unless `--force` is
passed, so a nightly cron converges without re-fetching settled history.

## Fields written

```yaml
sleep_hours: 7.4
body_battery_morning: 82
body_battery_min: 24
body_battery_max: 82
resting_hr: 48
steps: 11240
hrv_last_night: 78
```

Sleep is attributed to the **morning you woke up**, not the evening you fell
asleep — Garmin's day runs midnight to midnight while the vault's log day rolls
over at 04:00, so the two need an explicit rule.

## Cost

The client exposes range endpoints (`get_sleep_daily`, `get_body_battery`,
`get_rhr_daily`, `get_daily_steps`, `get_hrv_data_range`), so a month costs
five requests rather than one per day per metric. Requests are still chunked at
28 days, since these endpoints are undocumented and have been seen to truncate
long spans.

## Field mapping is unverified

Response shapes here were written against community usage, not against a live
account. Rather than guessing silently, any metric that arrives in an
unrecognised shape is reported at the end of the run with the keys that were
actually present:

```
garmin: 1 field(s) returned in an unrecognised shape:
  2026-08-15 body_battery: date, bodyBatteryValuesArray
Map these keys in pick() and re-run.
```

Expect to adjust `pick()` once after the first real run.

## Setup

```shell
pip install -r requirements.txt
GARMIN_EMAIL=you@example.com GARMIN_PASSWORD=... python enrich.py --days 3
```

Credentials are only needed for the first login; `garth` then caches OAuth
tokens under `~/.garminconnect` (mode 0600) and refreshes them automatically.
Set `GARMIN_TOKENS` to move that directory.

This uses Garmin's private endpoints — there is no free official API for
personal use. It is a grey area under Garmin's terms and will break when they
change authentication. Keep the manual path usable as a fallback.
