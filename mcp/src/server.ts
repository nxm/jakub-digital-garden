import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod";
import { assertDate, assertTime, localTime, logDay } from "./day.js";
import { appendEntry, readDayNote, totalKcal } from "./vault.js";

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
        "Append a thought, idea or observation to today's log. Keep the user's own words — do not summarise or tidy them.",
      inputSchema: z.object({
        text: z.string().min(1),
        date: dateField,
        time: timeField,
      }),
    },
    async ({ text, date, time }) => {
      const day = date ? assertDate(date) : logDay();
      const stamp = time ? assertTime(time) : localTime();

      await appendEntry(day, "Thoughts", [`### ${stamp}`, "", text].join("\n"));

      return { content: [{ type: "text" as const, text: `Saved to ${day} at ${stamp}.` }] };
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
