import ICAL from "ical.js";
import { log } from "../log.ts";

/**
 * Proton Calendar has no API or CalDAV, but each calendar can be shared as
 * a read-only ICS link (Calendar settings → the calendar → Share → "Share
 * with anyone"). Facteur reads those links: events, recurrences expanded.
 * The links contain the decryption key, so they're secrets (env only).
 */

export interface CalendarSource {
  name: string;
  url: string;
}

export interface CalEvent {
  calendar: string;
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  organizer?: string;
  attendees: string[];
  recurring: boolean;
  status?: string;
}

/** "Personal|https://…ics, Work|https://…ics" (a name is optional) */
export function parseSources(value: string | undefined): CalendarSource[] {
  if (!value) return [];
  return value
    .split(/[\n,](?=\s*(?:[^|,\n]+\|)?https:\/\/)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const bar = s.indexOf("|");
      const [name, url] = bar > 0 && !s.slice(0, bar).includes("://") ? [s.slice(0, bar).trim(), s.slice(bar + 1).trim()] : [`Calendar ${i + 1}`, s];
      if (!/^https:\/\//.test(url)) throw new Error(`calendar link for ${name} must be https`);
      return { name, url };
    });
}

const CACHE_MS = 5 * 60_000;

export class CalendarService {
  readonly sources: CalendarSource[];
  private cache = new Map<string, { at: number; comp: ICAL.Component }>();

  constructor(sources: CalendarSource[]) {
    this.sources = sources;
  }

  async events(from: Date, to: Date, opts: { calendar?: string; query?: string; limit?: number } = {}): Promise<CalEvent[]> {
    const pick = opts.calendar ? this.sources.filter((s) => s.name.toLowerCase() === opts.calendar!.toLowerCase()) : this.sources;
    if (opts.calendar && !pick.length) throw new Error(`no calendar "${opts.calendar}" (have: ${this.sources.map((s) => s.name).join(", ")})`);
    const out: CalEvent[] = [];
    const failures: string[] = [];
    await Promise.all(
      pick.map(async (src) => {
        try {
          out.push(...expand(src.name, await this.load(src), from, to));
        } catch (e) {
          failures.push(`${src.name}: ${(e as Error).message}`);
        }
      }),
    );
    if (failures.length && !out.length) throw new Error(`couldn't read the calendar: ${failures.join("; ")}`);
    let list = out.sort((a, b) => a.start.getTime() - b.start.getTime());
    if (opts.query) {
      const q = opts.query.toLowerCase();
      list = list.filter((e) => [e.title, e.location, e.description, e.organizer, ...e.attendees].join(" ").toLowerCase().includes(q));
    }
    return list.slice(0, opts.limit ?? 200);
  }

  private async load(src: CalendarSource): Promise<ICAL.Component> {
    const hit = this.cache.get(src.url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.comp;
    const res = await fetch(src.url, { headers: { accept: "text/calendar" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (is the share link still active?)`);
    const body = await res.text();
    if (body.length > 20 * 1024 * 1024) throw new Error("calendar feed is too large");
    const comp = new ICAL.Component(ICAL.parse(body));
    this.cache.set(src.url, { at: Date.now(), comp });
    log.debug("calendar loaded", { calendar: src.name, events: comp.getAllSubcomponents("vevent").length });
    return comp;
  }
}

/** every occurrence of every event that overlaps [from, to) */
export function expand(calendar: string, comp: ICAL.Component, from: Date, to: Date): CalEvent[] {
  const out: CalEvent[] = [];
  const vevents = comp.getAllSubcomponents("vevent");
  // overridden occurrences (RECURRENCE-ID) replace the generated ones
  const overrides = new Map<string, ICAL.Event>();
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) overrides.set(`${ev.uid}|${ev.recurrenceId.toJSDate().getTime()}`, ev);
  }
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) continue;
    if (!ev.isRecurring()) {
      const s = ev.startDate.toJSDate();
      const e = ev.endDate?.toJSDate() ?? s;
      if (e > from && s < to) out.push(toEvent(calendar, ev, s, e, false));
      continue;
    }
    const it = ev.iterator();
    const duration = (ev.endDate?.toJSDate().getTime() ?? ev.startDate.toJSDate().getTime()) - ev.startDate.toJSDate().getTime();
    for (let next = it.next(), n = 0; next && n < 5000; next = it.next(), n++) {
      const s = next.toJSDate();
      if (s >= to) break;
      const e = new Date(s.getTime() + duration);
      if (e <= from) continue;
      const o = overrides.get(`${ev.uid}|${s.getTime()}`);
      if (o) out.push(toEvent(calendar, o, o.startDate.toJSDate(), o.endDate?.toJSDate() ?? o.startDate.toJSDate(), true));
      else out.push(toEvent(calendar, ev, s, e, true));
    }
  }
  return out.filter((e) => e.status?.toUpperCase() !== "CANCELLED");
}

function toEvent(calendar: string, ev: ICAL.Event, start: Date, end: Date, recurring: boolean): CalEvent {
  const status = ev.component.getFirstPropertyValue("status");
  const organizer = ev.organizer ? String(ev.organizer).replace(/^mailto:/i, "") : undefined;
  return {
    calendar,
    uid: ev.uid,
    title: ev.summary || "(no title)",
    start,
    end,
    allDay: ev.startDate.isDate,
    ...(ev.location && { location: ev.location }),
    ...(ev.description && { description: ev.description }),
    ...(organizer && { organizer }),
    attendees: ev.attendees.map((a) => String(a.getFirstValue()).replace(/^mailto:/i, "")),
    recurring,
    ...(typeof status === "string" && { status }),
  };
}
