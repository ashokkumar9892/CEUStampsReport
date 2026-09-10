import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqlStore } from './db.js';

const config = loadConfig();
if (config.problems.length) {
  console.error(`The report cannot start:\n${config.problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const store = createSqlStore(config.sql);
const server = http.createServer(createApp({ config, store }));

server.listen(config.port, config.host, () => {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const reach = config.local ? 'this machine only' : 'network — password required, serve behind HTTPS';
  console.log(`CEU Stamps usage report: http://${host}:${config.port}  (${reach})`);
});

async function stop() {
  server.close();
  await store.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
