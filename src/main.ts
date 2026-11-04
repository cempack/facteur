import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Audit } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { log } from "./log.ts";
import { ALL_SCOPES } from "./mcp/context.ts";
import { buildServer, SERVER_VERSION } from "./mcp/server.ts";
import { Mailer } from "./mail/send.ts";
import { MailService } from "./mail/service.ts";

const cfg = loadConfig();
const mail = new MailService(cfg);
const mailer = new Mailer(cfg.bridge, cfg.identities[0]!);
const audit = new Audit(cfg.dataDir);
const deps = { mail, mailer, cfg, audit };

let shutdown: () => Promise<unknown>;

if (cfg.transport === "stdio") {
  // local use: one trusted process, every scope (FACTEUR_SCOPES can narrow it)
  const scopes = new Set((process.env.FACTEUR_SCOPES ?? ALL_SCOPES.join(" ")).split(/[\s,]+/).filter(Boolean));
  const server = buildServer({ ...deps, client: "stdio", scopes });
  await server.connect(new StdioServerTransport());
  log.info("facteur ready on stdio", { version: SERVER_VERSION, scopes: [...scopes] });
  shutdown = () => server.close();
} else {
  const { app, close } = createApp(cfg, deps);
  const http = app.listen(cfg.http.port, "0.0.0.0", () =>
    log.info("facteur listening", { version: SERVER_VERSION, port: cfg.http.port, url: `${cfg.http.publicUrl}/mcp` }),
  );
  shutdown = async () => {
    http.close();
    await close();
  };
}

// check Bridge at boot, without blocking it (Bridge may still be starting)
mail.pool
  .withClient((c) => c.noop())
  .then(() => log.info("bridge imap ok"))
  .catch((e) => log.warn("bridge imap not reachable yet", { error: String(e?.message ?? e) }));
mailer
  .verify()
  .then(() => log.info("bridge smtp ok"))
  .catch((e) => log.warn("bridge smtp not reachable yet", { error: String(e?.message ?? e) }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    log.info("shutting down", { signal: sig });
    await Promise.race([Promise.allSettled([shutdown(), mail.close(), Promise.resolve(mailer.close())]), new Promise((r) => setTimeout(r, 5_000))]);
    process.exit(0);
  });
}
