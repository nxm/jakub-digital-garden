import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";
import { assertDate, assertTime, localTime, logDay } from "./day.js";
import {
  appendEntry,
  appendThought,
  claimAttachment,
  findRecentAttachment,
  readDayNote,
  recordTraining,
  saveMealPhoto,
  totals,
} from "./vault.js";

const authToken = process.env["MCP_AUTH_TOKEN"];
if (!authToken) throw new Error("MCP_AUTH_TOKEN is required — refusing to expose an unauthenticated vault writer");

const port = Number(process.env["PORT"] ?? 8787);

// Loopback by default: in production a tunnel reaches this over localhost, and
// binding every interface would put a vault writer on the network by accident.
const host = process.env["HOST"] ?? "127.0.0.1";

// The transport does not check the Host header on its own. Behind a proxy the
// forwarded name has to be listed here too, or the guard rejects real traffic.
const allowedHosts = (process.env["ALLOWED_HOSTS"] ?? "localhost 127.0.0.1 [::1]").split(/\s+/).filter(Boolean);

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Vault day to write to. Omit for today — the server resolves the date itself, do not guess it.");

const timeField = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .optional()
  .describe("Wall-clock time of the entry. Omit to stamp with the current time.");

// A fresh server per request: instances are cheap, and sharing one across
// concurrent requests would mean sharing its transport too.
function buildServer(): McpServer {
  const server = new McpServer({ name: "garden-log", version: "0.1.0" });

  server.registerTool(
    "log_meal",
    {
      description:
        "Record something eaten or drunk in today's log. Identify the items and estimate portions from the " +
        "photo or description, then pass them as a list — the server sums the calories itself. " +
        "If the user attached a photo, the server files it with the entry on its own: there is no " +
        "argument for it and nothing for you to look up. " +
        "Set contains_fish whenever fish or seafood may be present: the user is allergic. " +
        "Write every label and item name in English no matter what language the user used: the vault is " +
        'written in English and these notes are published. Translate the dish ("jajecznica" becomes ' +
        '"scrambled eggs"), and keep the Polish name alongside only when the dish has no English ' +
        'equivalent worth translating, like "pierogi".',
      inputSchema: z.object({
        label: z.string().min(1).describe('Short name for the entry, e.g. "Breakfast smoothie".'),
        kind: z.enum(["meal", "drink"]).default("meal"),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              portion: z.string().min(1).describe('Estimated portion, e.g. "200 g" or "1 glass".'),
              kcal: z.number().int().nonnegative(),
              protein: z.number().int().nonnegative().optional().describe("Grams of protein."),
              carbs: z.number().int().nonnegative().optional().describe("Grams of carbohydrate."),
              fat: z.number().int().nonnegative().optional().describe("Grams of fat."),
            }),
          )
          .min(1),
        note: z
          .string()
          .optional()
          .describe("Anything worth keeping — context, how it felt, doubts about the estimate."),
        contains_fish: z.boolean().default(false),
        date: dateField,
        time: timeField,
      }),
    },
    async ({ label, kind, items, note, contains_fish, date, time }) => {
      const day = date ? assertDate(date) : logDay();
      const stamp = time ? assertTime(time) : localTime();
      const sum = (key: "kcal" | "protein" | "carbs" | "fat"): number =>
        items.reduce((running, item) => running + (item[key] ?? 0), 0);

      const kcal = sum("kcal");
      const macros = { protein: sum("protein"), carbs: sum("carbs"), fat: sum("fat") };
      const hasMacros = macros.protein + macros.carbs + macros.fat > 0;

      const marker = ["kcal=" + kcal]
        .concat(hasMacros ? Object.entries(macros).map(([k, v]) => `${k}=${v}`) : [])
        .join(" ");

      // Always checked, never asked about: if an unused image arrived in the
      // last few minutes it belongs to this entry. The claim is written only
      // once the copy succeeded, so a failure here leaves it free to retry.
      let embed: string | undefined;

      const attachment = await findRecentAttachment();
      if (attachment) {
        embed = `![[${await saveMealPhoto(attachment.path, day, stamp)}]]`;
        await claimAttachment(attachment);
      }

      const entry = [
        `### ${stamp} — ${label}`,
        "",
        ...(embed ? [embed, ""] : []),
        ...(contains_fish
          ? ["> [!warning] Possible fish or seafood — you are allergic. Check before eating.", ""]
          : []),
        hasMacros ? "| item | portion | kcal | P | C | F |" : "| item | portion | kcal |",
        hasMacros ? "| --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- |",
        ...items.map((item) =>
          hasMacros
            ? `| ${item.name} | ${item.portion} | ${item.kcal} | ${item.protein ?? "—"} | ${item.carbs ?? "—"} | ${item.fat ?? "—"} |`
            : `| ${item.name} | ${item.portion} | ${item.kcal} |`,
        ),
        "",
        ...(note ? [note, ""] : []),
        hasMacros
          ? `**~${kcal} kcal** · P ${macros.protein} g · C ${macros.carbs} g · F ${macros.fat} g <!-- totals ${marker} -->`
          : `**~${kcal} kcal** <!-- totals ${marker} -->`,
      ].join("\n");

      const updated = await appendEntry(day, kind === "drink" ? "Drinks" : "Meals", entry);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Logged "${label}" (~${kcal} kcal) to ${day} at ${stamp}.` +
              ` Day total: ~${totals(updated).kcal} kcal.` +
              (embed ? " Photo attached." : ""),
          },
        ],
      };
    },
  );

  server.registerTool(
    "log_thought",
    {
      description:
        "Append a thought, idea or observation to the day's private notes. Keep the user's own " +
        "words, in the language they used — do not summarise, tidy or translate them. Meals and " +
        "training get rewritten in English because they are published; thoughts are not, and a thought " +
        "loses its edge in translation. Keep it exactly as it was said.",
      inputSchema: z.object({
        text: z.string().min(1),
        date: dateField,
        time: timeField,
      }),
    },
    async ({ text, date, time }) => {
      const day = date ? assertDate(date) : logDay();
      const stamp = time ? assertTime(time) : localTime();

      await appendThought(day, [`### ${stamp}`, "", text].join("\n"));

      return { content: [{ type: "text" as const, text: `Saved privately to ${day} at ${stamp}.` }] };
    },
  );

  server.registerTool(
    "log_training",
    {
      description:
        "Record the day's training, or that there was none. Pass minutes: 0 for a rest day. " +
        "Do not judge whether a rest was planned or a session was skipped — the weekly plan in " +
        "Me/Training.md already says what the day was for, and comparing it against what happened " +
        "is more honest than a label chosen after the fact. Give a reason only if there is a real " +
        "one, like illness or travel; otherwise leave it out. Write the summary and reason in English " +
        "whatever language the request came in — these notes are published.",
      inputSchema: z.object({
        minutes: z
          .number()
          .int()
          .min(0)
          .describe("Total minutes trained across the day. 0 for a rest day."),
        summary: z
          .string()
          .optional()
          .describe('One line on what was done, e.g. "62 min strength, mostly zones 1–2".'),
        session: z
          .string()
          .optional()
          .describe('Basename of a session note to link, e.g. "session-2026-08-11".'),
        reason: z
          .string()
          .optional()
          .describe("Why there was no training, when there is an actual reason. Not for excuses."),
        date: dateField,
      }),
    },
    async ({ minutes, summary, session, reason, date }) => {
      const day = date ? assertDate(date) : logDay();

      const lines = [
        ...(minutes > 0 ? [`**${minutes} min**`] : ["Rest day."]),
        ...(summary ? ["", summary] : []),
        ...(session ? ["", `Session: [[${session}]]`] : []),
        ...(reason ? ["", reason] : []),
      ];

      const updated = await recordTraining(day, minutes, lines.join("\n"));

      return {
        content: [
          {
            type: "text" as const,
            text:
              minutes > 0
                ? `Logged ${minutes} min of training to ${day}.`
                : `Recorded ${day} as a rest day.` +
                  ` Day total still ~${totals(updated).kcal} kcal.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_day",
    {
      description: "Read back a day's log, including the running calorie total. Defaults to today.",
      inputSchema: z.object({ date: dateField }),
    },
    async ({ date }) => {
      const day = date ? assertDate(date) : logDay();
      const note = await readDayNote(day);

      return {
        content: [{ type: "text" as const, text: note ?? `Nothing logged for ${day} yet.` }],
      };
    },
  );

  return server;
}

function isAuthorised(request: http.IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;

  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(authToken as string);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const mcpHandler = toNodeHandler(createMcpHandler(() => buildServer()));
const validateHost = hostHeaderValidation(allowedHosts);

http
  .createServer((request, response) => {
    // Unauthenticated on purpose so a proxy can probe it; it says nothing else.
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }

    // Answers 403 itself when it returns false.
    if (!validateHost(request, response)) return;

    if (!isAuthorised(request)) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    mcpHandler(request, response);
  })
  .listen(port, host, () => {
    console.log(`garden-log MCP listening on ${host}:${port}`);
  });
