import { describe, expect, it } from "vitest";
import { parseAddressList } from "../src/mail/address.ts";
import { buildReplyBody, pickIdentity, prefixSubject, replyRecipients, replyReferences, type Original } from "../src/mail/compose.ts";
import { analyzeStructure, groupIds, parseId } from "../src/mail/message.ts";
import { parseDate, toImapSearch } from "../src/mail/search.ts";

const me = parseAddressList("Elliot <me@example.com>, alias@example.org");
const orig: Original = {
  messageId: "<m2@x>",
  references: ["<m1@x>"],
  subject: "Hello",
  date: "2026-11-01T10:00:00Z",
  from: [{ name: "Ana", address: "ana@x.com" }],
  replyTo: [],
  to: [{ address: "alias@example.org" }, { address: "bob@x.com" }],
  cc: [{ address: "me@example.com" }, { address: "carl@x.com" }],
  text: "Line one\n> older",
};

describe("ids", () => {
  it("splits mailbox and uid at the last slash", () => {
    expect(parseId("Folders/Work/88")).toEqual({ mailbox: "Folders/Work", uid: 88 });
    expect(() => parseId("INBOX")).toThrow();
    expect([...groupIds(["INBOX/1", "INBOX/2", "Sent/3", "INBOX/1"])]).toEqual([["INBOX", [1, 2]], ["Sent", [3]]]);
  });
});

describe("replies", () => {
  it("answers the sender, or everyone but me on reply-all", () => {
    expect(replyRecipients(orig, me, false)).toEqual({ to: [{ name: "Ana", address: "ana@x.com" }], cc: [] });
    const all = replyRecipients(orig, me, true);
    expect(all.cc.map((a) => a.address)).toEqual(["bob@x.com", "carl@x.com"]);
  });
  it("replies from the address the mail was sent to", () => {
    expect(pickIdentity(me, orig).address).toBe("alias@example.org");
    expect(() => pickIdentity(me, orig, "someone@else.com")).toThrow(/allowed senders/);
  });
  it("threads and quotes", () => {
    expect(replyReferences(orig)).toEqual(["<m1@x>", "<m2@x>"]);
    expect(prefixSubject("RE: Hello", "Re")).toBe("RE: Hello");
    expect(prefixSubject("Hello", "Fwd")).toBe("Fwd: Hello");
    const b = buildReplyBody({ text: "Thanks", html: "<!doctype html><html><body><p>Thanks</p></body></html>" }, orig);
    expect(b.text).toContain("> Line one\n>> older");
    expect(b.html).toContain("<blockquote");
  });
});

describe("search", () => {
  const now = new Date(2026, 10, 4, 15, 0);
  it("reads relative dates", () => {
    expect(parseDate("7d", now)).toEqual(new Date(2026, 9, 28));
    expect(parseDate("yesterday", now)).toEqual(new Date(2026, 10, 3));
    expect(() => parseDate("soon", now)).toThrow();
  });
  it("builds IMAP criteria", () => {
    expect(toImapSearch({ unread: true, from: "ana" }, now)).toEqual({ seen: false, from: "ana", deleted: false });
    expect(toImapSearch({}, now)).toEqual({ all: true, deleted: false });
  });
});

describe("structure", () => {
  it("finds text parts and attachments", () => {
    const r = analyzeStructure({
      type: "multipart/mixed",
      childNodes: [
        { type: "multipart/alternative", part: "1", childNodes: [{ type: "text/plain", part: "1.1", size: 10 }, { type: "text/html", part: "1.2", size: 20 }] },
        { type: "application/pdf", part: "2", disposition: "attachment", dispositionParameters: { filename: "a.pdf" }, size: 100 },
        { type: "image/png", part: "3", id: "<img1>", size: 50 },
      ],
    });
    expect(r.text).toEqual({ plain: { part: "1.1", size: 10 }, html: { part: "1.2", size: 20 } });
    expect(r.attachments.map((a) => [a.part, a.filename, a.inline])).toEqual([["2", "a.pdf", false], ["3", "part-3.png", true]]);
  });
});

import { baseSubject } from "../src/mail/service.ts";
describe("baseSubject", () => {
  it("strips reply and forward prefixes", () => {
    expect(baseSubject("Re: Fwd: TR: Hello")).toBe("Hello");
    expect(baseSubject("RE[2]: [list] Hello")).toBe("Hello");
  });
});
