import { describe, expect, it } from "vitest";
import { renderItem, viewItem } from "../src/pass/items.ts";
import { fillTemplate, parseRef } from "../src/pass/service.ts";
import { parseSources } from "../src/calendar/service.ts";

describe("pass items", () => {
  it("never shows secret fields, only their names", () => {
    const v = viewItem(
      {
        title: "GitHub",
        content: { username: "cempack", password: "hunter2", urls: ["https://github.com"], totpUri: "otpauth://totp/x?secret=ABC" },
        note: "recovery codes: 1234",
        extraFields: [{ name: "Team", type: "text", value: "core" }, { name: "API key", type: "hidden", value: "sk-123" }],
      },
      "pass://s/i",
    );
    const out = renderItem(v);
    expect(out).toContain("cempack");
    expect(out).toContain("https://github.com");
    expect(out).toContain("Team: core");
    for (const secret of ["hunter2", "ABC", "1234", "sk-123"]) expect(out).not.toContain(secret);
    expect(v.revealable).toEqual(expect.arrayContaining(["password", "totpUri", "note", "API key"]));
  });
  it("parses refs and fills templates", () => {
    expect(parseRef("pass://abc_=/def-1")).toEqual({ shareId: "abc_=", itemId: "def-1" });
    expect(() => parseRef("pass://a")).toThrow();
    expect(fillTemplate({ title: "", username: "", password: "", urls: [] }, { title: "T", password: "p", urls: ["u"] })).toEqual({ title: "T", username: "", password: "p", urls: ["u"] });
  });
});

describe("calendar sources", () => {
  it("reads named and unnamed links", () => {
    expect(parseSources("Perso|https://a.example/x.ics?k=1,Work|https://b.example/y.ics")).toEqual([
      { name: "Perso", url: "https://a.example/x.ics?k=1" },
      { name: "Work", url: "https://b.example/y.ics" },
    ]);
    expect(parseSources("https://a.example/x.ics")[0]!.name).toBe("Calendar 1");
    expect(() => parseSources("Perso|http://insecure.example/x.ics")).toThrow();
    // webcal links are https feeds under a subscribe-me label
    expect(parseSources("Foot|webcal://ics.example/team.ics, School|WEBCALS://edt.example/a.ics")).toEqual([
      { name: "Foot", url: "https://ics.example/team.ics" },
      { name: "School", url: "https://edt.example/a.ics" },
    ]);
    expect(parseSources("X|HTTPS://a.example/x.ics")[0]!.url).toBe("https://a.example/x.ics");
  });
});

import ICAL from "ical.js";
import { expand } from "../src/calendar/service.ts";
describe("calendar expand", () => {
  it("expands weekly events and applies overrides", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test",
      "BEGIN:VEVENT", "UID:a", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Standup", "END:VEVENT",
      "BEGIN:VEVENT", "UID:a", "RECURRENCE-ID:20261109T090000Z", "DTSTART:20261109T110000Z", "DTEND:20261109T120000Z", "SUMMARY:Standup (moved)", "END:VEVENT",
      "BEGIN:VEVENT", "UID:b", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106", "SUMMARY:Holiday", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const evs = expand("Perso", new ICAL.Component(ICAL.parse(ics)), new Date("2026-11-01T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));
    expect(evs.map((e) => e.title).sort()).toEqual(["Holiday", "Standup", "Standup", "Standup (moved)"]);
    expect(evs.find((e) => e.title === "Holiday")?.allDay).toBe(true);
  });
});

describe("pass item layout from pass-cli 2.7", () => {
  it("shows login metadata and hides the rest", () => {
    const raw = {
      item: {
        id: "i".repeat(88), share_id: "s".repeat(88), vault_id: "v".repeat(88),
        content: {
          title: "Bank", note: "pin is 4321", item_uuid: "abcd1234",
          content: { Login: { email: "me@x.com", username: "", password: "s3cret!", urls: ["https://bank.example"], totp_uri: "otpauth://totp/a?secret=XYZ", passkeys: [], autofill_urls: [] } },
          extra_fields: [{ name: "Customer no", content: { Text: "998877" } }, { name: "Security answer", content: { Hidden: "blue" } }],
          platform_specific: { android: null }, custom_icon: null,
        },
        state: "Active", flags: [], create_time: "2026-01-01 10:00:00", modify_time: "2026-02-01 10:00:00",
      },
      attachments: [],
    };
    const v = viewItem(raw, "pass://s/i");
    const out = renderItem(v);
    expect(v.type).toBe("Login");
    expect(out).toContain("me@x.com");
    expect(out).toContain("https://bank.example");
    expect(out).toContain("Customer no: 998877");
    for (const secret of ["s3cret!", "XYZ", "4321", "blue", "v".repeat(20), "abcd1234"]) expect(out).not.toContain(secret);
    expect([...new Set(v.revealable)].sort()).toEqual(["Security answer", "note", "password", "totp_uri"]);
  });
});
