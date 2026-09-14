import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { D1DatabaseAdapter } from '../apps/api/src/adapters/cloudflare/d1-database.ts';
import { SqliteDatabaseAdapter } from '../apps/api/src/adapters/node/sqlite-database.ts';

class FakeD1Statement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeD1Statement(this.owner, this.sql, params);
  }

  async first() {
    this.owner.calls.push({ method: 'first', sql: this.sql, params: this.params });
    return { id: 'first-row' };
  }

  async all() {
    this.owner.calls.push({ method: 'all', sql: this.sql, params: this.params });
    return { results: [{ id: 'row-1' }, { id: 'row-2' }], meta: { changes: 0, last_row_id: 0 } };
  }

  async run() {
    this.owner.calls.push({ method: 'run', sql: this.sql, params: this.params });
    return { results: [], meta: { changes: 1, last_row_id: 7 } };
  }
}

class FakeD1Database {
  constructor() {
    this.calls = [];
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test('D1 adapter maps portable statements and binary parameters without leaking D1 shapes', async () => {
  const fake = new FakeD1Database();
  const database = new D1DatabaseAdapter(fake);
  const binary = new Uint8Array([1, 2, 3]);

  assert.deepEqual(await database.first({ sql: 'SELECT ?', params: ['x'] }), { id: 'first-row' });
  assert.deepEqual(await database.all({ sql: 'SELECT all' }), [{ id: 'row-1' }, { id: 'row-2' }]);
  assert.deepEqual(await database.run({ sql: 'INSERT ?', params: [binary] }), { changes: 1, lastInsertRowId: 7 });
  assert.deepEqual(await database.batch([{ sql: 'UPDATE a' }, { sql: 'UPDATE b' }]), [
    { changes: 1, lastInsertRowId: 7 },
    { changes: 1, lastInsertRowId: 7 },
  ]);

  const insertCall = fake.calls.find((call) => call.sql === 'INSERT ?');
  assert.ok(insertCall.params[0] instanceof ArrayBuffer);
});

test('SQLite adapter implements the same query and atomic batch contract', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const database = new SqliteDatabaseAdapter(sqlite);
  try {
    await database.run({ sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)' });
    const batch = await database.batch([
      { sql: 'INSERT INTO items (code) VALUES (?)', params: ['A'] },
      { sql: 'INSERT INTO items (code) VALUES (?)', params: ['B'] },
    ]);
    assert.equal(batch.length, 2);
    assert.equal(batch[0].changes, 1);
    assert.deepEqual(await database.first({ sql: 'SELECT code FROM items WHERE id=?', params: [1] }), { code: 'A' });
    assert.deepEqual(await database.all({ sql: 'SELECT code FROM items ORDER BY id' }), [{ code: 'A' }, { code: 'B' }]);

    await assert.rejects(database.batch([
      { sql: 'INSERT INTO items (code) VALUES (?)', params: ['C'] },
      { sql: 'INSERT INTO items (code) VALUES (?)', params: ['A'] },
    ]));
    assert.equal((await database.first({ sql: 'SELECT COUNT(*) AS count FROM items' })).count, 2);
  } finally {
    sqlite.close();
  }
});
