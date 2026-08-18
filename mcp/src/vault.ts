import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { assertDate, dayTitle } from "./day.js";

const execFile = promisify(execFileCb);

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

/** Index of the section's heading, creating it in canonical order when absent.
 *
 * A section outside `order` is appended: the session note has no fixed shape,
 * and guessing a position among headings this file knows nothing about would
 * scatter someone's own writing.
 */
function ensureSection(lines: string[], section: string, order: readonly string[] = SECTIONS): number {
  const existing = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (existing !== -1) return existing;

  // Slot the new heading before the first section that outranks it, so the note
  // keeps Meals / Drinks / Training order however they happen to be created.
  const position = order.indexOf(section);
  const following = position === -1 ? [] : order.slice(position + 1);
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
function replaceSection(note: string, section: string, body: string, order?: readonly string[]): string {
  const lines = note.split("\n");
  const headingIndex = ensureSection(lines, section, order);

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

/** A day's session note, which is where the lifts themselves are written down.
 *
 * The name is derived from the date rather than passed in, so the day note can
 * link to it without anyone naming a file: the link and the note cannot drift
 * apart if neither side gets a say in what it is called.
 */
export function sessionNotePath(date: string): string {
  return join(vaultRoot, "Me", "Training", `session-${assertDate(date)}.md`);
}

export async function sessionExists(date: string): Promise<boolean> {
  return stat(sessionNotePath(date)).then(
    () => true,
    () => false,
  );
}

function emptySessionNote(date: string, focus: string | undefined): string {
  return [
    "---",
    `title: ${date} – ${focus ?? "Training"}`,
    `date: ${date}`,
    "tags:",
    "  - training",
    "---",
    "",
    "Related: [[Training]]",
    "",
  ].join("\n");
}

/** Writes the day's lifts into its session note, leaving the rest of it alone.
 *
 * Only the `Exercises` section is replaced. These notes also carry what Garmin
 * recorded and whatever was written by hand afterwards, and re-logging a set
 * should not cost someone the paragraph they wrote about how the session felt.
 */
export function recordSession(date: string, focus: string | undefined, body: string): Promise<string> {
  const path = sessionNotePath(date);

  return withFileLock(path, async () => {
    const existing = await readFile(path, "utf8").catch(() => emptySessionNote(date, focus));
    const updated = replaceSection(existing, "Exercises", body, []);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${updated.replace(/\n+$/, "")}\n`, "utf8");
    return updated;
  });
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

// Where moltis parks channel attachments, whether they arrived as a Telegram
// photo or as a document.
const mediaRoot = process.env["MOLTIS_MEDIA_ROOT"] ?? "/var/lib/moltis/sessions/media/v1";

// Outside the vault, so the publisher never sees it. It only ever holds which
// attachment was used last, which is worth nothing to anyone but this process.
const stateRoot = process.env["GARDEN_STATE_DIR"] ?? join(vaultRoot, "..", ".garden-state");
const claimPath = join(stateRoot, "claimed-attachment.json");

// How far back an attachment still counts as "the one just sent". Long enough
// to survive a slow model or a retry, short enough that yesterday's lunch never
// gets stapled to today's.
const RECENT_ATTACHMENT_MS = 15 * 60 * 1000;

// Anything moltis saved that a note could not display is not a meal photo.
const IMAGE_EXTENSIONS = /\.(jpe?g|png|heic|heif|webp|gif)$/i;

type Attachment = { path: string; mtime: number };

async function readClaim(): Promise<Attachment | undefined> {
  try {
    return JSON.parse(await readFile(claimPath, "utf8")) as Attachment;
  } catch {
    return undefined;
  }
}

/** Marks an attachment as used, so it attaches to exactly one entry.
 *
 * Without this the next meal logged from plain text — no photo sent — would pick
 * up the previous one all over again, since recency alone cannot tell a fresh
 * photo from one that has already been filed.
 */
export async function claimAttachment(attachment: Attachment): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(claimPath, JSON.stringify(attachment), "utf8");
}

/** The most recently saved attachment, if one arrived just now and is unused.
 *
 * The model is never asked whether a photo was attached. It is asked to identify
 * what is in the picture, which it can only do when one is there, so the flag
 * carried no information the server could not get for itself — and a weaker
 * model forgetting to set it silently dropped the photo.
 *
 * Matching by filename is not available either: moltis strips every argument
 * starting with `_` before forwarding to a remote MCP server, so neither the
 * session key nor the saved filename reaches this process. Recency plus a claim
 * needs nothing from anyone.
 */
export async function findRecentAttachment(): Promise<Attachment | undefined> {
  let newest: Attachment | undefined;

  for (const session of await readdir(mediaRoot).catch(() => [])) {
    const files = join(mediaRoot, session, "files");
    for (const candidate of await readdir(files).catch(() => [])) {
      if (!IMAGE_EXTENSIONS.test(candidate)) continue;

      const path = join(files, candidate);
      const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: 0 }));
      if (!newest || mtimeMs > newest.mtime) newest = { path, mtime: mtimeMs };
    }
  }

  if (!newest || Date.now() - newest.mtime > RECENT_ATTACHMENT_MS) return undefined;

  const claimed = await readClaim();
  if (claimed && claimed.path === newest.path && claimed.mtime === newest.mtime) return undefined;

  return newest;
}

/** Copies an attachment into the vault, downscaled, and returns its basename.
 *
 * Downscaling is not tidiness: these notes are committed to a public repository
 * and git keeps every version forever, so a few megabytes per meal would be
 * unrecoverable once pushed. A meal photo is documentation, not an archive
 * master, and 1600px is more than a note ever renders.
 */
export async function saveMealPhoto(source: string, date: string, stamp: string): Promise<string> {
  const name = `meal-${date}-${stamp.replace(":", "")}.jpg`;
  const target = join(vaultRoot, "media", name);

  await mkdir(dirname(target), { recursive: true });

  try {
    await execFile("magick", [source, "-auto-orient", "-resize", "1600x1600>", "-quality", "82", target]);
  } catch {
    // Without ImageMagick the note is still worth more than the megabytes saved.
    await copyFile(source, target);
  }

  return name;
}
