export const DEFAULT_TIMEZONE = "Europe/Warsaw";

// The log day rolls over at 04:00 local time rather than midnight, so a 01:00
// snack still lands on the day it belongs to instead of opening a fresh one.
const ROLLOVER_HOUR = 4;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    return Number(part.value);
  };

  // Some ICU builds emit hour 24 for midnight under hour12:false.
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function isoDate(year: number, month: number, day: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The vault date an event belongs to, honouring the 04:00 rollover. */
export function logDay(instant: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = localParts(instant, timeZone);
  if (parts.hour >= ROLLOVER_HOUR) return isoDate(parts.year, parts.month, parts.day);

  const previous = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  previous.setUTCDate(previous.getUTCDate() - 1);
  return isoDate(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

/** Wall-clock HH:MM used to stamp an entry. */
export function localTime(instant: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  const parts = localParts(instant, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

// Spelled out rather than taken from Intl: the day note is written in English
// regardless of what locale the host happens to run under.
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** ISO-8601 week number, so a week runs Monday to Sunday. */
function isoWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const point = new Date(Date.UTC(year, month - 1, day));

  // Shift to the Thursday of this week: the ISO year is whichever year that
  // Thursday falls in, which is what makes the turn of the year come out right.
  const weekday = point.getUTCDay() || 7;
  point.setUTCDate(point.getUTCDate() + 4 - weekday);

  const yearStart = Date.UTC(point.getUTCFullYear(), 0, 1);
  return Math.ceil(((point.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** `2026-08-17 · Monday · W34` */
export function dayTitle(date: string): string {
  const [year, month, day] = assertDate(date).split("-").map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;

  return `${date} · ${WEEKDAYS[weekday]} · W${String(isoWeek(date)).padStart(2, "0")}`;
}

export function assertDate(value: string): string {
  if (!DATE_RE.test(value)) throw new Error(`Expected a YYYY-MM-DD date, got "${value}"`);
  return value;
}

export function assertTime(value: string): string {
  if (!TIME_RE.test(value)) throw new Error(`Expected an HH:MM time, got "${value}"`);
  return value;
}
