import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CalEvent, CalendarService } from "../../calendar/service.ts";
import { parseDate } from "../../mail/search.ts";
import { safe, text, type ToolContext } from "../context.ts";

type CalendarContext = ToolContext & { calendar: CalendarService };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerCalendarTools(server: McpServer, ctx: CalendarContext) {
  const tz = ctx.cfg.timeZone;
  const fmt = (d: Date, allDay: boolean) =>
    allDay ? d.toLocaleDateString("sv-SE", { timeZone: tz }) : d.toLocaleString("sv-SE", { timeZone: tz, hour12: false }).slice(0, 16);

  const render = (e: CalEvent) => {
    const when = e.allDay
      ? `${fmt(e.start, true)}${e.end.getTime() - e.start.getTime() > 86_400_000 ? ` → ${fmt(new Date(e.end.getTime() - 1), true)}` : ""} (all day)`
      : `${fmt(e.start, false)} → ${fmt(e.end, false).slice(e.start.toDateString() === e.end.toDateString() ? 11 : 0)}`;
    const lines = [`• ${when}  ${e.title}${ctx.calendar.sources.length > 1 ? `  [${e.calendar}]` : ""}${e.recurring ? "  (repeats)" : ""}`];
    if (e.location) lines.push(`  Where: ${e.location}`);
    if (e.organizer) lines.push(`  Organizer: ${e.organizer}`);
    if (e.attendees.length) lines.push(`  With: ${e.attendees.slice(0, 10).join(", ")}${e.attendees.length > 10 ? " …" : ""}`);
    if (e.description) lines.push(`  Notes: ${e.description.replace(/\s+/g, " ").slice(0, 300)}`);
    return lines.join("\n");
  };

  server.registerTool(
    "calendar_events",
    {
      title: "Calendar events",
      description:
        `Events from Proton Calendar (read-only) between two dates, recurring ones expanded, in ${tz}. ` +
        `Calendars: ${ctx.calendar.sources.map((s) => s.name).join(", ")}. Default: today and the next 7 days.`,
      inputSchema: z.object({
        from: z.string().default("today").describe('Start: "today", "2026-11-04", an ISO date-time, or "-7d" for 7 days ago.'),
        to: z.string().optional().describe('End (exclusive): a date, or a span after from like "+7d", "+1m". Default +7d.'),
        query: z.string().optional().describe("Only events whose title, place, notes or people contain this."),
        calendar: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: READ,
    },
    safe("calendar_events", ctx, async ({ from, to, query, calendar, limit }) => {
      const start = when(from, new Date());
      const end = to ? when(to, start) : new Date(start.getTime() + 7 * 86_400_000);
      if (end <= start) throw new Error("to must be after from");
      const events = await ctx.calendar.events(start, end, { query, calendar, limit });
      const range = `${fmt(start, true)} → ${fmt(new Date(end.getTime() - 1), true)}`;
      if (!events.length) return text(`No events ${range}${query ? ` matching "${query}"` : ""}.`);
      return text(`${events.length} event${events.length > 1 ? "s" : ""}, ${range}:\n\n<calendar untrusted>\n${events.map(render).join("\n\n")}\n</calendar>`);
    }),
  );
}

/** "+7d" / "-2w" relative to base, or anything parseDate understands */
function when(v: string, base: Date): Date {
  const m = /^([+-])(\d+)\s*([dwmy])$/i.exec(v.trim());
  if (!m) return parseDate(v);
  const d = new Date(base);
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  const unit = m[3]!.toLowerCase();
  if (unit === "d") d.setDate(d.getDate() + n);
  else if (unit === "w") d.setDate(d.getDate() + 7 * n);
  else if (unit === "m") d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d;
}
