import http from 'node:http';
import { createApiSource } from './api.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqlSource } from './db.js';
import { createLocator, withLocations } from './geo.js';
import { createRads10Source, fillVisitLocations } from './rads10.js';

const config = loadConfig();
if (config.problems.length) {
  console.error(`The report cannot start:\n${config.problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const base = config.source === 'api' ? createApiSource(config.api) : createSqlSource(config.sql);
const locate = createLocator();
const source = config.geoip ? withLocations(base, locate, { budgetMs: 20_000 }) : base;
// The RADS10 tab is read from the API only; with REPORT_SOURCE=sql it has no data.
const rads10 = config.source === 'api' ? createRads10Source(config.api) : null;
const sources = {
  ceu: source,
  rads10: rads10 && config.geoip ? withLocations(rads10, locate, { budgetMs: 20_000, fill: fillVisitLocations }) : rads10,
};
const server = http.createServer(createApp({ config, source: sources }));

server.listen(config.port, config.host, () => {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const reach = config.local ? 'this machine only' : 'network — password required, serve behind HTTPS';
  const from = config.source === 'api' ? new URL(config.api.url).origin : `${config.sql.database} as ${config.sql.user}`;
  console.log(`CEU Stamps usage report: http://${host}:${config.port}  (${reach}; data from ${from})`);
});

async function stop() {
  server.close();
  await source.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
