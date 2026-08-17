import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";
import { assertDate, assertTime, localTime, logDay } from "./day.js";
import { appendEntry, appendThought, readDayNote, recordTraining, totalKcal } from "./vault.js";

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
        "Set contains_fish whenever fish or seafood may be present: the user is allergic.",
      inputSchema: z.object({
        label: z.string().min(1).describe('Short name for the entry, e.g. "Breakfast smoothie".'),
        kind: z.enum(["meal", "drink"]).default("meal"),
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              portion: z.string().min(1).describe('Estimated portion, e.g. "200 g" or "1 glass".'),
              kcal: z.number().int().nonnegative(),
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
      const kcal = items.reduce((sum, item) => sum + item.kcal, 0);

      const entry = [
        `### ${stamp} — ${label}`,
        "",
        ...(contains_fish
          ? ["> [!warning] Possible fish or seafood — you are allergic. Check before eating.", ""]
          : []),
        "| item | portion | kcal |",
        "| --- | --- | --- |",
        ...items.map((item) => `| ${item.name} | ${item.portion} | ${item.kcal} |`),
        "",
        ...(note ? [note, ""] : []),
        `**~${kcal} kcal** <!-- kcal=${kcal} -->`,
      ].join("\n");

      const updated = await appendEntry(day, kind === "drink" ? "Drinks" : "Meals", entry);

      return {
        content: [
          {
            type: "text" as const,
            text: `Logged "${label}" (~${kcal} kcal) to ${day} at ${stamp}. Day total: ~${totalKcal(updated)} kcal.`,
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
        "words — do not summarise or tidy them. Unlike meals and training, thoughts are never " +
        "published: they go to a note the site does not build and the repository does not track.",
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
        "one, like illness or travel; otherwise leave it out.",
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
                  ` Day total still ~${totalKcal(updated)} kcal.`,
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
