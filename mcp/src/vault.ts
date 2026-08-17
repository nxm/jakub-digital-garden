import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertDate } from "./day.js";

export const SECTIONS = ["Meals", "Drinks", "Thoughts"] as const;
export type Section = (typeof SECTIONS)[number];

// Each intake entry carries its calories in an HTML comment: invisible in
// Obsidian's reading view, but trivial to re-sum when refreshing the total.
const KCAL_MARKER = /<!-- kcal=(\d+) -->/g;
const KCAL_FRONTMATTER = /^kcal: \d+$/m;

const vaultRoot = resolve(process.env["VAULT_PATH"] ?? join(import.meta.dirname, "..", "..", "docs"));

export function dayNotePath(date: string): string {
  return join(vaultRoot, "private", "log", `${assertDate(date)}.md`);
}

function emptyNote(date: string): string {
  return [
    "---",
    `title: ${date} – Log`,
    `date: ${date}`,
    "tags:",
    "  - log",
    "publish: false",
    "kcal: 0",
    "---",
    "",
    "Related: [[Diet]], [[Training]]",
    "",
    ...SECTIONS.flatMap((section) => [`## ${section}`, ""]),
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

function insertIntoSection(note: string, section: Section, entry: string): string {
  const lines = note.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (headingIndex === -1) throw new Error(`Day note has no "## ${section}" section`);

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

export function totalKcal(note: string): number {
  let total = 0;
  for (const match of note.matchAll(KCAL_MARKER)) total += Number(match[1]);
  return total;
}

function refreshKcalTotal(note: string): string {
  return note.replace(KCAL_FRONTMATTER, `kcal: ${totalKcal(note)}`);
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

export async function appendEntry(date: string, section: Section, entry: string): Promise<string> {
  const path = dayNotePath(date);

  return withFileLock(path, async () => {
    const existing = (await readDayNote(date)) ?? emptyNote(date);
    const updated = refreshKcalTotal(insertIntoSection(existing, section, entry));

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${updated.replace(/\n+$/, "")}\n`, "utf8");
    return updated;
  });
}
