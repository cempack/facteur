import { describe, expect, it } from "vitest";
import { checkDrivePath, checkName, childPath, cliError, driveArgs, driveConfigFromEnv, nodeName, parseCliJson } from "../src/drive/service.ts";

describe("drive paths", () => {
  it("accepts absolute paths and trims a trailing slash", () => {
    expect(checkDrivePath("/my-files/Docs/a.pdf")).toBe("/my-files/Docs/a.pdf");
    expect(checkDrivePath("/my-files/")).toBe("/my-files");
    expect(checkDrivePath("/")).toBe("/");
    expect(checkDrivePath("/my-files/foo\\/bar")).toBe("/my-files/foo\\/bar");
    expect(checkDrivePath("/my-files/..notes")).toBe("/my-files/..notes");
  });

  it("rejects relative paths, dot segments, control characters and leading dashes", () => {
    expect(() => checkDrivePath("")).toThrow();
    expect(() => checkDrivePath("my-files/a")).toThrow(/absolute/);
    expect(() => checkDrivePath("-rf")).toThrow(/absolute/);
    expect(() => checkDrivePath("--json")).toThrow();
    expect(() => checkDrivePath("/my-files/../trash")).toThrow(/\.\./);
    expect(() => checkDrivePath("/my-files/./a")).toThrow();
    expect(() => checkDrivePath("/my-files/..")).toThrow();
    expect(() => checkDrivePath("/my-files//a")).toThrow(/empty/);
    expect(() => checkDrivePath("/my-files/a\nb")).toThrow(/control/);
    expect(() => checkDrivePath("/my-files/a\u0000")).toThrow(/control/);
    expect(() => checkDrivePath("/my-files/-v")).toThrow(/-/);
  });

  it("validates single names", () => {
    expect(checkName("Invoices 2026")).toBe("Invoices 2026");
    for (const bad of ["", " ", "a/b", "a\\b", ".", "..", "-x", "a\tb", "x".repeat(256)]) expect(() => checkName(bad)).toThrow();
  });

  it("escapes slashes in child names", () => {
    expect(childPath("/my-files", "a/b")).toBe("/my-files/a\\/b");
    expect(childPath("/", "my-files")).toBe("/my-files");
  });
});

describe("drive arguments", () => {
  it("puts options first and positionals after --", () => {
    expect(driveArgs.list("/my-files/Docs")).toEqual(["filesystem", "list", "--json", "--", "/my-files/Docs"]);
    expect(driveArgs.list("/my-files", "folder")).toEqual(["filesystem", "list", "--json", "--type", "folder", "--", "/my-files"]);
    expect(driveArgs.info("/my-files/a.pdf")).toEqual(["filesystem", "info", "--json", "--", "/my-files/a.pdf"]);
    expect(driveArgs.createFolder("/my-files", "Invoices")).toEqual(["filesystem", "create-folder", "--json", "--", "/my-files", "Invoices"]);
    expect(driveArgs.rename("/my-files/a", "b")).toEqual(["filesystem", "rename", "--json", "--", "/my-files/a", "b"]);
    expect(driveArgs.move(["/my-files/a", "/my-files/b"], "/my-files/c")).toEqual(["filesystem", "move", "--json", "--", "/my-files/a", "/my-files/b", "/my-files/c"]);
    expect(driveArgs.trash(["/my-files/a"])).toEqual(["filesystem", "trash", "--json", "--", "/my-files/a"]);
  });

  it("always sets conflict strategies so the CLI never prompts", () => {
    expect(driveArgs.upload("/tmp/x/a.pdf", "/my-files/Inbox", "new_revision")).toEqual([
      "filesystem", "upload", "--json", "--file-conflict-strategy", "create-new-revision", "--folder-conflict-strategy", "skip",
      "--", "/tmp/x/a.pdf", "/my-files/Inbox",
    ]);
    const dl = driveArgs.download("/my-files/a.pdf", "/tmp/d");
    expect(dl).toContain("--file-conflict-strategy");
    expect(dl.slice(-3)).toEqual(["--", "/my-files/a.pdf", "/tmp/d"]);
  });

  it("validates every path and name before building", () => {
    expect(() => driveArgs.list("../etc")).toThrow();
    expect(() => driveArgs.move([], "/my-files")).toThrow();
    expect(() => driveArgs.move(["/my-files/a"], "-rf")).toThrow();
    expect(() => driveArgs.createFolder("/my-files", "--help")).toThrow();
    expect(() => driveArgs.rename("/my-files/a", "x/y")).toThrow();
    expect(() => driveArgs.upload("/tmp/a", "/my-files/../x", "rename")).toThrow();
  });

  it("builds sharing commands with inline values", () => {
    expect(driveArgs.setUrl("/my-files/a", { role: "viewer", password: "-p w", expiration: "2026-12-31" })).toEqual([
      "sharing", "set-url", "--json", "--role", "viewer", "--password=-p w", "--expiration", "2026-12-31", "--", "/my-files/a",
    ]);
    expect(() => driveArgs.setUrl("/my-files/a", { expiration: "tomorrow" })).toThrow(/ISO/);
    expect(driveArgs.invite("/my-files/a", ["ana@x.com"], "editor", "hi")).toEqual([
      "sharing", "invite", "--json", "--role", "editor", "--user", "ana@x.com", "--message=hi", "--", "/my-files/a",
    ]);
    expect(() => driveArgs.invite("/my-files/a", ["-x@y.z"], "viewer")).toThrow();
    expect(() => driveArgs.invite("/my-files/a", ["not an email"], "viewer")).toThrow();
    expect(driveArgs.removeAccess("/my-files/a", "everyone")).toEqual(["sharing", "remove", "--json", "--everyone", "--", "/my-files/a"]);
  });
});

describe("drive output", () => {
  it("parses single objects and streamed arrays", () => {
    expect(parseCliJson('{"uid":"1"}\n')).toEqual({ uid: "1" });
    expect(parseCliJson('[\n{"uid":"1"},\n{"uid":"2"}\n]\n')).toEqual([{ uid: "1" }, { uid: "2" }]);
    expect(parseCliJson("[\n\n]\n")).toEqual([]);
    expect(parseCliJson('Uploading 1/1\n{"transferredItems":1}\n')).toEqual({ transferredItems: 1 });
    expect(parseCliJson("")).toBeUndefined();
  });

  it("turns CLI errors into short messages", () => {
    expect(cliError("You need to login first\n", "x").message).toMatch(/not signed in: run `proton-drive auth login`/);
    expect(cliError("===\nTrace: NotFoundError: Node not found\n    at foo (bar.ts:1)\n", "x").message).toBe("Proton Drive: NotFoundError: Node not found");
    expect(cliError("", "filesystem list failed").message).toBe("Proton Drive: filesystem list failed");
  });

  it("reads node names from SDK results", () => {
    expect(nodeName({ uid: "u", type: "file", name: { ok: true, value: "a.pdf" } })).toBe("a.pdf");
    expect(nodeName({ uid: "u", type: "file", name: { ok: false, error: { name: "broken.pdf", error: "bad signature" } } })).toBe("broken.pdf");
    expect(nodeName({ uid: "u", type: "file", name: { ok: false, error: {} } })).toBe("u");
  });

  it("reads its config from the environment", () => {
    expect(driveConfigFromEnv({ FACTEUR_DATA_DIR: "/data" })).toMatchObject({ bin: "proton-drive", dir: "/data/drive", timeoutMs: 60_000 });
    expect(driveConfigFromEnv({ PROTON_DRIVE_CACHE_DIR: "/srv/d", FACTEUR_DRIVE_BIN: "/opt/pd", FACTEUR_DRIVE_TIMEOUT_S: "5" })).toMatchObject({
      bin: "/opt/pd",
      dir: "/srv/d",
      timeoutMs: 5_000,
    });
  });
});
