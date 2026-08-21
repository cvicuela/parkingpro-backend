#!/usr/bin/env node
/**
 * Load schema.sql + database/migrations/*.sql (in order) into the DEVELOP BRANCH
 * database. Reads DATABASE_URL from .env at runtime (the password never leaves
 * the .env file). SAFETY: refuses to run unless DATABASE_URL targets the branch.
 *
 * Usage: node scripts/load-branch-schema.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

// The develop branch project ref. The script will ONLY run against this DB.
const EXPECTED_REF = 'meqkyvffamkashqctpbd';
const PROD_REF = 'ppxjjsfacbepctslyrma';

const url = process.env.DATABASE_URL || '';
if (!url) {
  console.error('ABORT: DATABASE_URL is not set in .env');
  process.exit(1);
}
if (url.includes(PROD_REF) || !url.includes(EXPECTED_REF)) {
  console.error(`SAFETY ABORT: DATABASE_URL must target the develop branch (${EXPECTED_REF}).`);
  console.error('Refusing to apply schema/migrations to a non-branch database (migration 022 resets operational data).');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const dbDir = path.join(__dirname, '..', 'database');
const migDir = path.join(dbDir, 'migrations');

async function runFile(label, sql) {
  try {
    await pool.query(sql);
    console.log(`  OK   ${label}`);
    return null;
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    console.log(`  FAIL ${label}: ${msg}`);
    return { label, error: msg };
  }
}

(async () => {
  const who = await pool.query('SELECT current_database() AS db, current_user AS usr');
  console.log('Connected:', who.rows[0]);

  const failures = [];
  const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  const f0 = await runFile('schema.sql', schema);
  if (f0) failures.push(f0);

  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const fail = await runFile(`migrations/${f}`, sql);
    if (fail) failures.push(fail);
  }

  console.log(`\nDone. ${files.length + 1} files applied, ${failures.length} failure(s).`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach(f => console.log(`  - ${f.label}: ${f.error}`));
  }
  await pool.end();
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
