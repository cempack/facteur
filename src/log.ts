/**
 * One JSON line per event on stderr (stdout belongs to the MCP stdio
 * transport). Never log message bodies, tokens or passwords.
 */
type Fields = Record<string, unknown>;

function write(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Fields) {
  if (level === "debug" && !process.env.FACTEUR_DEBUG) return;
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

export const log = {
  debug: (msg: string, f?: Fields) => write("debug", msg, f),
  info: (msg: string, f?: Fields) => write("info", msg, f),
  warn: (msg: string, f?: Fields) => write("warn", msg, f),
  error: (msg: string, f?: Fields) => write("error", msg, f),
};
