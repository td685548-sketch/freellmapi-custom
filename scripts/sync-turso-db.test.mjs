import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlLiteral, getTursoConfig, topologicalSortTables } from './sync-turso-db.mjs';

test('sqlLiteral encodes SQL values safely', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(123), '123');
  assert.equal(sqlLiteral(123.45), '123.45');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral(false), '0');
  assert.equal(sqlLiteral('hello world'), "'hello world'");
  assert.equal(sqlLiteral("O'Reilly"), "'O''Reilly'");
  assert.equal(sqlLiteral(Buffer.from('abc')), "X'616263'");
});

test('getTursoConfig extracts URL and token from env', () => {
  const customEnv = {
    TURSO_DATABASE_URL: 'libsql://custom-db.turso.io',
    TURSO_AUTH_TOKEN: 'custom-token-12345',
  };
  const cfg = getTursoConfig(customEnv);
  assert.equal(cfg.url, 'libsql://custom-db.turso.io');
  assert.equal(cfg.token, 'custom-token-12345');
});

test('topologicalSortTables orders parent tables before child tables', () => {
  // Mock localDb with foreign key relationships:
  // child -> parent
  // grandchild -> child
  // standalone has no dependencies
  const fkMap = {
    users: [],
    models: [],
    fallback_config: [{ table: 'models' }],
    user_api_keys: [{ table: 'users' }],
    request_attempts: [{ table: 'requests' }],
    requests: [{ table: 'users' }, { table: 'models' }],
    standalone: [],
  };

  const mockDb = {
    prepare(sql) {
      return {
        all() {
          const match = sql.match(/PRAGMA foreign_key_list\("([^"]+)"\)/);
          if (match && fkMap[match[1]]) {
            return fkMap[match[1]];
          }
          return [];
        }
      };
    }
  };

  const tables = Object.keys(fkMap).map(name => ({ name }));
  const sorted = topologicalSortTables(mockDb, tables);

  // Assert parents appear before children
  const idxUsers = sorted.indexOf('users');
  const idxUserApiKeys = sorted.indexOf('user_api_keys');
  const idxModels = sorted.indexOf('models');
  const idxFallback = sorted.indexOf('fallback_config');
  const idxRequests = sorted.indexOf('requests');
  const idxAttempts = sorted.indexOf('request_attempts');

  assert.ok(idxUsers < idxUserApiKeys, 'users must precede user_api_keys');
  assert.ok(idxModels < idxFallback, 'models must precede fallback_config');
  assert.ok(idxUsers < idxRequests, 'users must precede requests');
  assert.ok(idxModels < idxRequests, 'models must precede requests');
  assert.ok(idxRequests < idxAttempts, 'requests must precede request_attempts');
});
