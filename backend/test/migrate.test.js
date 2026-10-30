// backend/test/migrate.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runMigrations, ensureMigrationsTable, getAppliedMigrations } = require('../scripts/migrate');

function createMockPool() {
  const executedStatements = [];
  const migrationsRecord = [];

  const pool = {
    executedStatements,
    migrationsRecord,
    execute: async (sql, params = []) => {
      executedStatements.push({ sql: sql.trim(), params });

      if (sql.includes('SELECT name FROM schema_migrations')) {
        return [migrationsRecord.map((name) => ({ name }))];
      }

      if (sql.includes('INSERT INTO schema_migrations')) {
        migrationsRecord.push(params[0]);
        return [{ insertId: migrationsRecord.length }];
      }

      return [{ affectedRows: 1 }];
    },
  };

  return pool;
}

test('ensureMigrationsTable executes table creation', async () => {
  const pool = createMockPool();
  await ensureMigrationsTable(pool);
  assert.ok(pool.executedStatements.some((s) => s.sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
});

test('getAppliedMigrations returns array of migration names', async () => {
  const pool = createMockPool();
  pool.migrationsRecord.push('001_first.sql', '002_second.sql');

  const applied = await getAppliedMigrations(pool);
  assert.deepEqual(applied, ['001_first.sql', '002_second.sql']);
});

test('runMigrations applies pending migrations in alphabetical order and records them', async () => {
  const pool = createMockPool();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apidash-mig-'));

  try {
    fs.writeFileSync(path.join(tempDir, '002_b.sql'), 'CREATE TABLE b (id INT);');
    fs.writeFileSync(path.join(tempDir, '001_a.sql'), 'CREATE TABLE a (id INT);');

    const result = await runMigrations(pool, tempDir);

    assert.deepEqual(result.applied, ['001_a.sql', '002_b.sql']);
    assert.deepEqual(pool.migrationsRecord, ['001_a.sql', '002_b.sql']);

    // Second run: nothing to apply
    const secondResult = await runMigrations(pool, tempDir);
    assert.deepEqual(secondResult.applied, []);
    assert.deepEqual(secondResult.alreadyApplied, ['001_a.sql', '002_b.sql']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runMigrations stops on failure and does not record failed migration', async () => {
  const pool = createMockPool();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apidash-mig-fail-'));

  try {
    fs.writeFileSync(path.join(tempDir, '001_good.sql'), 'CREATE TABLE good (id INT);');
    fs.writeFileSync(path.join(tempDir, '002_bad.sql'), 'INVALID SQL SYNTAX;');

    // Override pool to fail on bad sql
    const originalExecute = pool.execute;
    pool.execute = async (sql, params) => {
      if (sql.includes('INVALID SQL SYNTAX')) {
        throw new Error('You have an error in your SQL syntax');
      }
      return originalExecute(sql, params);
    };

    await assert.rejects(
      () => runMigrations(pool, tempDir),
      /You have an error in your SQL syntax/
    );

    // 001_good succeeded and was recorded, 002_bad was NOT recorded
    assert.deepEqual(pool.migrationsRecord, ['001_good.sql']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
