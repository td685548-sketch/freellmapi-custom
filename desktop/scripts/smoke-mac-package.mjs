// Run with the PACKAGED Electron executable and ELECTRON_RUN_AS_NODE=1.
// This exercises its Electron ABI, bundled server, native SQLite module and
// HTTP API without opening windows or using the developer's app data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appPath, expectedArch] = process.argv.slice(2);
assert.ok(appPath && ['arm64', 'x64'].includes(expectedArch), 'usage: smoke-mac-package.mjs <app> <arm64|x64>');
assert.equal(process.platform, 'darwin');
assert.ok(process.versions.electron, 'Must run under the packaged Electron executable');
assert.equal(process.arch, expectedArch);
const resources = resolve(appPath, 'Contents/Resources');
const sqliteBinary = join(resources, 'app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const nativeArch = expectedArch === 'x64' ? 'x86_64' : 'arm64';
for (const binary of [process.execPath, sqliteBinary]) {
  assert.equal(execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim(), nativeArch);
}

const directory = mkdtempSync(join(tmpdir(), 'freellmapi-package-smoke-'));
// Never load repository .env settings or start catalog downloads in this test.
process.chdir(directory);
process.env.FREEAPI_ENV_PATH = join(directory, '.env');
process.env.CATALOG_SYNC_DISABLED = '1';
let server;
let db;
const timeout = setTimeout(() => {
  console.error('Packaged macOS backend smoke test timed out');
  process.exit(1);
}, 60_000);
let exitCode = 1;
try {
  const backend = await import(pathToFileURL(join(resources, 'app.asar/build/server.mjs')).href);
  ({ server } = await backend.startServer({
    dbPath: join(directory, 'smoke.db'),
    clientDist: join(resources, 'client-dist'),
    host: '127.0.0.1',
    preferredPort: 0,
  }));
  db = backend.getDb();
  db.exec('CREATE TABLE package_smoke (value TEXT NOT NULL)');
  db.prepare('INSERT INTO package_smoke VALUES (?)').run(expectedArch);
  assert.equal(db.prepare('SELECT value FROM package_smoke').get().value, expectedArch);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Phase 2: the session token never reaches JS — there is no
  // ensureSessionToken() anymore. The desktop window signs in by POSTing
  // /api/auth/desktop-session and authenticating with the httpOnly cookie
  // the server sets; assert the cookie is set and that it authenticates.
  const desktopSession = await fetch(`${baseUrl}/api/auth/desktop-session`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(desktopSession.status, 200);
  const sessionCookie = desktopSession.headers
    .getSetCookie()
    .find((c) => c.startsWith('flm_session='))
    ?.split(';')[0];
  assert.ok(sessionCookie, 'desktop-session must set the flm_session cookie');
  const status = await fetch(`${baseUrl}/api/auth/status`, {
    headers: { Cookie: sessionCookie },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).authenticated, true);
  const dashboard = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<html/i);
  // The unified key is hash-only server-side since #155, so there is no
  // getUnifiedApiKey() export anymore: regenerate a fresh key (shown once)
  // and use it as the Bearer token for this smoke test.
  const models = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${backend.regenerateUnifiedKey()}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(models.status, 200);
  assert.ok(Array.isArray((await models.json()).data));
  console.log(`Packaged ${expectedArch} backend passed: SQLite, session, dashboard and /v1/models`);
  exitCode = 0;
} catch (error) {
  console.error(error);
} finally {
  clearTimeout(timeout);
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  db?.close();
  process.chdir(tmpdir());
  rmSync(directory, { recursive: true, force: true });
  // The production backend starts recurring maintenance timers.
  process.exit(exitCode);
}
