import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertDate, dayTitle } from "./day.js";

// What you ate and what you trained, in that order. Thoughts are deliberately
// not here: they live in a separate note that never reaches the repository.
export const SECTIONS = ["Meals", "Drinks", "Training"] as const;
export type Section = (typeof SECTIONS)[number];

// Each intake entry carries its numbers in an HTML comment: invisible in
// Obsidian's reading view, but trivial to re-sum when refreshing the totals.
// Macros are optional, so a marker only names what that entry actually had.
// Both spellings: entries written before macros existed carry a bare
// `<!-- kcal=289 -->`, and dropping them would silently deflate a day's total
// the next time anything is logged to it.
const TOTALS_MARKER = /<!-- (?:totals )?((?:\w+=\d+\s*)+)-->/g;

export type Totals = { kcal: number; protein: number; carbs: number; fat: number };

const vaultRoot = resolve(process.env["VAULT_PATH"] ?? join(import.meta.dirname, "..", "..", "docs"));

export function dayNotePath(date: string): string {
  return join(vaultRoot, "Daily", `${assertDate(date)}.md`);
}

/** Thoughts get their own note under private/, which is gitignored.
 *
 * The day note is published, and log_thought exists to capture whatever was
 * said out loud without tidying it — which is exactly the material that should
 * not travel to a public repository ten minutes later, unreviewed. Splitting
 * along the publishable boundary keeps one automation from deciding that.
 */
export function thoughtsNotePath(date: string): string {
  return join(vaultRoot, "private", "thoughts", `${assertDate(date)}.md`);
}

// Sections are created on first use rather than stubbed out up front, so a day
// with only meals does not carry an empty "## Training". It also lets the Garmin
// enricher create a note from frontmatter alone without duplicating this shape.
function emptyNote(date: string): string {
  return [
    "---",
    `title: ${dayTitle(date)}`,
    `date: ${date}`,
    "tags:",
    "  - daily",
    "kcal: 0",
    "---",
    "",
    "Related: [[Diet]], [[Training]]",
    "",
  ].join("\n");
}

function emptyThoughtsNote(date: string): string {
  return [
    "---",
    `title: ${date} – Thoughts`,
    `date: ${date}`,
    "tags:",
    "  - thoughts",
    "publish: false",
    "---",
    "",
  ].join("\n");
}

export async function readDayNote(date: string): Promise<string | undefined> {
  try {
    return await readFile(dayNotePath(date), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Index of the section's heading, creating it in canonical order when absent. */
function ensureSection(lines: string[], section: Section): number {
  const existing = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (existing !== -1) return existing;

  // Slot the new heading before the first section that outranks it, so the note
  // keeps Meals / Drinks / Thoughts order however they happen to be created.
  const following = SECTIONS.slice(SECTIONS.indexOf(section) + 1);
  const successor = lines.findIndex((line) => following.some((later) => line.trim() === `## ${later}`));
  const at = successor === -1 ? lines.length : successor;

  lines.splice(at, 0, `## ${section}`, "");
  return at;
}

function insertIntoSection(note: string, section: Section, entry: string): string {
  const lines = note.split("\n");
  const headingIndex = ensureSection(lines, section);

  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (lines[index]?.startsWith("## ")) {
      sectionEnd = index;
      break;
    }
  }

  // Drop the blank padding at the tail of the section so spacing stays even.
  let insertAt = sectionEnd;
  while (insertAt > headingIndex + 1 && lines[insertAt - 1]?.trim() === "") insertAt--;

  lines.splice(insertAt, 0, "", ...entry.split("\n"));
  return lines.join("\n");
}

/** Replaces a whole section's body. */
function replaceSection(note: string, section: Section, body: string): string {
  const lines = note.split("\n");
  const headingIndex = ensureSection(lines, section);

  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index++) {
    if (lines[index]?.startsWith("## ")) {
      sectionEnd = index;
      break;
    }
  }

  lines.splice(headingIndex + 1, sectionEnd - headingIndex - 1, "", ...body.split("\n"), "");
  return lines.join("\n");
}

/** Sets a top-level frontmatter key, adding it when the note lacks one. */
function setFrontmatter(note: string, key: string, value: string): string {
  const existing = new RegExp(`^${key}: .*$`, "m");
  if (existing.test(note)) return note.replace(existing, `${key}: ${value}`);

  // Append just inside the closing fence, so the tags list above stays intact.
  const closing = note.indexOf("\n---\n", 4);
  if (closing === -1) throw new Error("day note is missing its frontmatter fence");
  return `${note.slice(0, closing)}\n${key}: ${value}${note.slice(closing)}`;
}

export function totals(note: string): Totals {
  const summed: Totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  for (const [, fields] of note.matchAll(TOTALS_MARKER)) {
    for (const [, key, value] of (fields ?? "").matchAll(/(\w+)=(\d+)/g)) {
      if (key && key in summed) summed[key as keyof Totals] += Number(value);
    }
  }

  return summed;
}

/** Macros stay out of the frontmatter until something reports them, so a day
 *  logged without them shows no protein rather than a misleading zero. */
function refreshTotals(note: string): string {
  const summed = totals(note);
  let updated = setFrontmatter(note, "kcal", String(summed.kcal));

  for (const macro of ["protein", "carbs", "fat"] as const) {
    if (summed[macro] > 0) updated = setFrontmatter(updated, `${macro}_g`, String(summed[macro]));
  }

  return updated;
}

// Appends are serialised per file: two tool calls landing in the same second
// would otherwise read the same note and the second write would drop the first.
const writeQueues = new Map<string, Promise<unknown>>();

function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const pending = (writeQueues.get(key) ?? Promise.resolve()).then(task, task);
  writeQueues.set(
    key,
    pending.catch(() => undefined),
  );
  return pending;
}

async function updateNote(date: string, change: (note: string) => string): Promise<string> {
  const path = dayNotePath(date);

  return withFileLock(path, async () => {
    const updated = refreshTotals(change((await readDayNote(date)) ?? emptyNote(date)));

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${updated.replace(/\n+$/, "")}\n`, "utf8");
    return updated;
  });
}

export function appendEntry(date: string, section: Section, entry: string): Promise<string> {
  return updateNote(date, (note) => insertIntoSection(note, section, entry));
}

/** Records the day's training state, replacing whatever was there before.
 *
 * A day has one training state, unlike meals which accumulate, so this replaces
 * rather than appends and stays safe to call twice.
 *
 * `minutes` is written to the frontmatter only when training is logged. An empty
 * note deliberately has no training_minutes at all: nothing recorded and a rest
 * day are different facts, and a default of 0 would erase the distinction.
 */
export function recordTraining(date: string, minutes: number, body: string): Promise<string> {
  return updateNote(date, (note) =>
    setFrontmatter(replaceSection(note, "Training", body), "training_minutes", String(minutes)),
  );
}

export async function readThoughtsNote(date: string): Promise<string | undefined> {
  try {
    return await readFile(thoughtsNotePath(date), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Appends to the day's private thoughts note, which the site never builds. */
export function appendThought(date: string, entry: string): Promise<string> {
  const path = thoughtsNotePath(date);

  return withFileLock(path, async () => {
    const existing = (await readThoughtsNote(date)) ?? emptyThoughtsNote(date);
    const updated = `${existing.replace(/\n+$/, "")}\n\n${entry}`;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${updated}\n`, "utf8");
    return updated;
  });
}
