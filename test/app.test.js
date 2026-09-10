import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { sourceFromStore } from '../server/db.js';
import { sessionRows, signInRows } from './fixtures.js';

const quiet = { error() {} };

function fakeStore(calls = []) {
  return {
    async reportSessions(from, to) {
      calls.push({ from, to });
      return sessionRows;
    },
    async reportSignIns() {
      return signInRows;
    },
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function request(server, path, { method = 'GET', headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const RANGE = '/api/report?from=2026-09-01T07:00:00.000Z&to=2026-09-10T07:00:00.000Z';

describe('local mode', () => {
  let server;
  const calls = [];
  before(async () => {
    server = await listen(createApp({ config: { local: true, auth: null }, source: sourceFromStore(fakeStore(calls)), log: quiet }));
  });
  after(() => server.close());

  test('serves the page with a strict CSP', async () => {
    const res = await request(server, '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /Usage report/);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('serves the shared modules and nothing else', async () => {
    assert.equal((await request(server, '/shared/format.js')).status, 200);
    assert.equal((await request(server, '/server/config.js')).status, 404);
    assert.equal((await request(server, '/../package.json')).status, 404);
    assert.equal((await request(server, '/.env')).status, 404);
  });

  test('passes the UTC window through to the queries', async () => {
    const res = await request(server, `${RANGE}&includeDemo=1`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.totals.sittings, 7);
    assert.equal(body.includeDemo, true);
    assert.equal(calls.at(-1).from.toISOString(), '2026-09-01T07:00:00.000Z');
    assert.equal(calls.at(-1).to.toISOString(), '2026-09-10T07:00:00.000Z');
  });

  test('rejects bare dates and backwards ranges', async () => {
    assert.equal((await request(server, '/api/report?from=2026-09-01&to=2026-09-10')).status, 400);
    const backwards = await request(server, '/api/report?from=2026-09-10T00:00:00Z&to=2026-09-01T00:00:00Z');
    assert.equal(backwards.status, 400);
    assert.match(JSON.parse(backwards.body).error, /after its start/);
  });

  test('refuses proxied requests and foreign Host headers', async () => {
    assert.equal((await request(server, '/', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
    assert.equal((await request(server, '/', { headers: { Forwarded: 'for=1.2.3.4' } })).status, 403);
    assert.equal((await request(server, '/', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(server, '/', { headers: { Host: 'localhost:5180' } })).status, 200);
  });

  test('only GET and HEAD', async () => {
    assert.equal((await request(server, RANGE, { method: 'POST' })).status, 405);
  });
});

describe('database errors', () => {
  test('are reported with a hint, as 502', async () => {
    const store = {
      reportSessions: async () => {
        throw Object.assign(new Error("Client with IP address '1.2.3.4' is not allowed to access the server."), { code: 'ELOGIN' });
      },
      reportSignIns: async () => [],
    };
    const server = await listen(createApp({ config: { local: true, auth: null }, source: sourceFromStore(store), log: quiet }));
    try {
      const res = await request(server, RANGE);
      assert.equal(res.status, 502);
      assert.match(JSON.parse(res.body).error, /firewall/);
    } finally {
      server.close();
    }
  });
});

describe('password', () => {
  let server;
  before(async () => {
    const config = { local: false, auth: { user: 'ops', password: 's3cret' } };
    server = await listen(createApp({ config, source: sourceFromStore(fakeStore()), log: quiet }));
  });
  after(() => server.close());

  const basic = (text) => ({ Authorization: `Basic ${Buffer.from(text).toString('base64')}` });

  test('asks for credentials', async () => {
    const res = await request(server, '/');
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'], /^Basic/);
  });

  test('rejects a wrong password and accepts the right one', async () => {
    assert.equal((await request(server, RANGE, { headers: basic('ops:nope') })).status, 401);
    assert.equal((await request(server, RANGE, { headers: basic('ops:s3cret') })).status, 200);
  });
});

describe('config', () => {
  const api = { REPORT_API_KEY: 'k' };
  const sql = { REPORT_SOURCE: 'sql', REPORT_SQL_PASSWORD: 'x' };

  test('defaults to the live API over https, on loopback', () => {
    const config = loadConfig(api);
    assert.deepEqual(config.problems, []);
    assert.equal(config.source, 'api');
    assert.equal(config.api.url, 'https://ceustamps-api.azurewebsites.net');
    assert.equal(config.local, true);
  });

  test('needs the admin key in API mode, and nothing from SQL', () => {
    assert.deepEqual(loadConfig({}).problems.length, 1);
    assert.match(loadConfig({}).problems[0], /REPORT_API_KEY/);
  });

  test('never sends the key over plain http, except to this machine', () => {
    assert.match(loadConfig({ ...api, REPORT_API_URL: 'http://ceustamps-api.azurewebsites.net' }).problems[0], /https/);
    assert.deepEqual(loadConfig({ ...api, REPORT_API_URL: 'http://localhost:8787' }).problems, []);
    assert.match(loadConfig({ ...api, REPORT_API_URL: 'not a url' }).problems[0], /not a URL/);
  });

  test('SQL mode defaults to the report login and needs its password', () => {
    const config = loadConfig(sql);
    assert.deepEqual(config.problems, []);
    assert.equal(config.sql.user, 'ceustamps_report');
    assert.equal(config.sql.database, 'ceustampsdb');
    assert.match(loadConfig({ REPORT_SOURCE: 'sql' }).problems[0], /REPORT_SQL_PASSWORD/);
  });

  test('refuses the live API login and the admin', () => {
    assert.equal(loadConfig({ ...sql, REPORT_SQL_USER: 'ceustamps_app' }).problems.length, 1);
    assert.equal(loadConfig({ ...sql, REPORT_SQL_USER: 'TradeAlgoAdmin' }).problems.length, 1);
  });

  test('refuses an unknown source', () => {
    assert.match(loadConfig({ ...api, REPORT_SOURCE: 'csv' }).problems[0], /REPORT_SOURCE/);
  });

  test('refuses to listen on the network without a password', () => {
    assert.match(loadConfig({ ...api, REPORT_HOST: '0.0.0.0' }).problems[0], /REPORT_AUTH_USER/);
    const guarded = loadConfig({ ...api, REPORT_HOST: '0.0.0.0', REPORT_AUTH_USER: 'a', REPORT_AUTH_PASSWORD: 'b' });
    assert.deepEqual(guarded.problems, []);
  });
});
