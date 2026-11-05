import ICAL from "ical.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * webcal:// (and webcals://) is how calendar apps say "subscribe to this":
 * the feed itself is plain HTTP, so it's fetched as https://. Never plain
 * http://, since these links carry the calendar's key.
 */
export function normalizeCalendarUrl(url: string): string {
  const u = url.trim().replace(/^(webcals?|https):\/\//i, "https://");
  if (!/^https:\/\//i.test(u)) throw new Error("calendar links must start with https:// or webcal://");
  return u;
}

/** "Personal|https://…ics, Work|webcal://…ics" (a name is optional) */
export function parseSources(value: string | undefined): CalendarSource[] {
  if (!value) return [];
  return value
    .split(/[\n,](?=\s*(?:[^|,\n]+\|)?(?:https|webcals?):\/\/)/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const bar = s.indexOf("|");
      const [name, url] = bar > 0 && !s.slice(0, bar).includes("://") ? [s.slice(0, bar).trim(), s.slice(bar + 1).trim()] : [`Calendar ${i + 1}`, s];
      try {
        return { name, url: normalizeCalendarUrl(url) };
      } catch {
        throw new Error(`calendar link for ${name} must start with https:// or webcal://`);
      }
    });
}

const CACHE_MS = 5 * 60_000;

export class CalendarService {
  private readonly fromEnv: CalendarSource[];
  private readonly file?: string;
  private cache = new Map<string, { at: number; comp: ICAL.Component }>();

  /** links from the environment, plus the ones added on the dashboard (saved in `file`) */
  constructor(fromEnv: CalendarSource[], file?: string) {
    this.fromEnv = fromEnv;
    this.file = file;
  }

  get sources(): CalendarSource[] {
    return [...this.fromEnv, ...this.saved()];
  }

  isFromEnv(name: string) {
    return this.fromEnv.some((s) => s.name === name);
  }

  add(name: string, url: string) {
    const [src] = parseSources(`${name.replace(/[|,\n]/g, " ").trim() || "Calendar"}|${url.trim()}`);
    if (!src) throw new Error("that isn't a calendar link");
    if (this.sources.some((s) => s.name.toLowerCase() === src.name.toLowerCase())) throw new Error(`there's already a calendar called ${src.name}`);
    this.save([...this.saved(), src]);
  }

  remove(name: string) {
    this.save(this.saved().filter((s) => s.name !== name));
    this.cache.clear();
  }

  private saved(): CalendarSource[] {
    if (!this.file) return [];
    try {
      const list = JSON.parse(readFileSync(this.file, "utf8")) as CalendarSource[];
      return Array.isArray(list) ? list.filter((s) => s && typeof s.name === "string" && /^https:\/\//.test(s.url)) : [];
    } catch {
      return [];
    }
  }

  private save(list: CalendarSource[]) {
    if (!this.file) throw new Error("no data directory to save calendars in");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(list, null, 1), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  async events(from: Date, to: Date, opts: { calendar?: string; query?: string; limit?: number } = {}): Promise<CalEvent[]> {
    const pick = opts.calendar ? this.sources.filter((s) => s.name.toLowerCase() === opts.calendar!.toLowerCase()) : this.sources;
    if (!this.sources.length) throw new Error("no calendar is connected yet: add a share link under Connections on Facteur's home page");
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
