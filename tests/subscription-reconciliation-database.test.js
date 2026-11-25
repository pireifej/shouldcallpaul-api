'use strict';
// Isolated PostgreSQL and mocked RevenueCat only. No app database URLs or real identities.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { fixture, userId, projectId, fromId, originalId, targetId, authorizationId } =
  require('./helpers/subscription-reconciliation');
const available = spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status === 0;

test('subscription reconciliation PostgreSQL constraints, atomicity, concurrent completion, and rollback',
  { skip: !available, timeout: 120000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pou-reconciliation-test-'));
    const data = path.join(dir, 'data');
    let pool, started = false, hook = null, updateAttempts = 0;
    try {
      execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'],
        { stdio: 'pipe', timeout: 40000 });
      execFileSync('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-t', '20',
        '-o', `-h '' -k ${dir} -p 15435`, 'start'], { stdio: 'pipe', timeout: 25000 });
      started = true;
      pool = new Pool({ host: dir, port: 15435, user: 'postgres', database: 'postgres', max: 6 });
      // Match the legacy account schema: user_id has no key until this additive
      // migration supplies the unique index required by the account foreign key.
      await pool.query(`CREATE TABLE public."user" (
        user_id INTEGER, revenuecat_app_user_id TEXT UNIQUE)`);
      const migration = fs.readFileSync(path.join(__dirname, '../migrations/subscription-identity-reconciliation.sql'), 'utf8');
      await pool.query(migration);
      const wrapped = {
        query: (...args) => pool.query(...args),
        async connect() {
          const db = await pool.connect();
          return { release: () => db.release(), async query(sql, args) {
            if (sql.startsWith('UPDATE public."user"')) updateAttempts++;
            if (hook) await hook(sql, db);
            return db.query(sql, args);
          } };
        }
      };
      async function reset({ approve = true } = {}) {
        hook = null; updateAttempts = 0;
        await pool.query('TRUNCATE public.subscription_identity_reconciliations, public."user"');
        await pool.query('INSERT INTO public."user"(user_id,revenuecat_app_user_id) VALUES($1,$2),(99,NULL)', [userId, fromId]);
        const f = fixture({ pool: wrapped }); f.target.exists = true;
        if (approve) await pool.query(
          `INSERT INTO public.subscription_identity_reconciliations
           (id,user_id,project_id,from_customer_id,to_customer_id,original_customer_id,
            approved_at,approved_by,expires_at,evidence_reference)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [authorizationId, userId, projectId, fromId, targetId, originalId, f.approval.approved_at,
            f.approval.approved_by, f.approval.expires_at, f.approval.evidence_reference]);
        return f;
      }
      const mapping = async () => (await pool.query(
        'SELECT revenuecat_app_user_id FROM public."user" WHERE user_id=$1', [userId])).rows[0].revenuecat_app_user_id;
      const completed = async () => (await pool.query(
        'SELECT completed_at FROM public.subscription_identity_reconciliations WHERE id=$1',
        [authorizationId])).rows[0]?.completed_at;

      await t.test('migration is additive and re-runnable without approvals or mapping resets', async () => {
        const f = await reset();
        await pool.query(migration);
        assert.equal(await mapping(), fromId); assert.equal(await completed(), null);
        assert.equal((await pool.query('SELECT count(*) FROM public.subscription_identity_reconciliations')).rows[0].count, '1');
        assert(await f.offer()); assert.equal(updateAttempts, 0); assert.equal(await mapping(), fromId);
      });

      await t.test('duplicate legacy account IDs abort the prerequisite index without modifying either account', async () => {
        await pool.query(`CREATE SCHEMA synthetic_conflict;
          CREATE TABLE synthetic_conflict."user"(user_id INTEGER);
          INSERT INTO synthetic_conflict."user" VALUES(42),(42)`);
        const db = await pool.connect();
        try {
          await assert.rejects(db.query(migration.replaceAll('public.', 'synthetic_conflict.')),
            error => error.code === '23505');
          await db.query('ROLLBACK');
          assert.equal((await db.query('SELECT count(*) FROM synthetic_conflict."user" WHERE user_id=42')).rows[0].count, '2');
          assert.equal((await db.query("SELECT to_regclass('synthetic_conflict.subscription_identity_reconciliations') AS relation")).rows[0].relation, null);
        } finally { db.release(); }
      });

      await t.test('database prevents another account reusing approved customer identities', async () => {
        await reset();
        for (const [source, target, original] of [
          [fromId, 'pou_v1_' + 'a'.repeat(43), '$RCAnonymousID:another'],
          ['another-legacy', targetId, '$RCAnonymousID:another'],
          ['another-legacy', 'pou_v1_' + 'a'.repeat(43), originalId]
        ]) await assert.rejects(pool.query(
          `INSERT INTO public.subscription_identity_reconciliations
           SELECT 'aaaaaaaa-1234-4234-8234-123456789abc',99,project_id,$1,$2,$3,
           approved_at,approved_by,expires_at,NULL,evidence_reference
           FROM public.subscription_identity_reconciliations WHERE id=$4`,
          [source, target, original, authorizationId]), error => error.code === '23505');
        assert.equal(await mapping(), fromId);
        await assert.rejects(pool.query(
          'INSERT INTO public."user"(user_id,revenuecat_app_user_id) VALUES($1,NULL)',
          [userId]), error => error.code === '23505');
      });

      await t.test('anonymous source, invalid destination, invalid expiry, and orphan account are rejected', async () => {
        await reset();
        for (const [column, value, code] of [
          ['from_customer_id', '$RCAnonymousID:source', '23514'],
          ['to_customer_id', 'foreign-client-chosen-id', '23514'],
          ['expires_at', new Date('2000-01-01T00:00:00Z'), '23514'],
          ['user_id', 999, '23503']
        ]) await assert.rejects(pool.query(
          `UPDATE public.subscription_identity_reconciliations SET ${column}=$1 WHERE id=$2`,
          [value, authorizationId]), error => error.code === code);
      });

      await t.test('missing/foreign approval cannot alter mappings or query RevenueCat', async () => {
        const f = await reset({ approve: false });
        await assert.rejects(f.complete(), e => e.statusCode === 403);
        assert.equal(f.reads.length, 0); assert.equal(await mapping(), fromId);
        assert.equal((await pool.query('SELECT count(*) FROM public.subscription_identity_reconciliations')).rows[0].count, '0');
      });

      await t.test('simultaneous completions are idempotent and perform exactly one mapping update', async () => {
        const f = await reset(), originalHistory = structuredClone(f.source);
        const results = await Promise.all([f.complete(), f.complete(), f.complete()]);
        assert(results.every(result => result.completed && result.revenuecatAppUserId === targetId));
        assert.equal(await mapping(), targetId); assert(await completed());
        assert.equal(updateAttempts, 1); assert.deepEqual(f.source, originalHistory);
        const count = f.reads.length; f.status = 503;
        await f.complete(); assert.equal(f.reads.length, count);
        f.status = 200;
        assert.equal((await f.pro.getProStatus({ userId })).isPro, false);
      });

      await t.test('a failure recording completion rolls back the mapping change', async () => {
        const f = await reset();
        hook = async sql => {
          if (sql.startsWith('UPDATE public.subscription_identity_reconciliations')) throw new Error('synthetic-final-write-failure');
        };
        await assert.rejects(f.complete(), e => e.statusCode === 503 && !e.message.includes('synthetic'));
        assert.equal(await mapping(), fromId); assert.equal(await completed(), null);
      });

      await t.test('database expiry during commit rolls back the mapping, rather than leaving a partial transition', async () => {
        const f = await reset();
        hook = async (sql, db) => {
          if (sql.startsWith('UPDATE public.subscription_identity_reconciliations')) {
            await db.query(`UPDATE public.subscription_identity_reconciliations
              SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [authorizationId]);
          }
        };
        await assert.rejects(f.complete(), e => e.statusCode === 410);
        assert.equal(await mapping(), fromId); assert.equal(await completed(), null);
      });

      await t.test('an account changed between provider review and the locked transaction is preserved', async () => {
        const f = await reset();
        hook = async sql => {
          if (sql === 'BEGIN') {
            await pool.query('UPDATE public."user" SET revenuecat_app_user_id=$1 WHERE user_id=$2',
              ['operator-changed-mapping', userId]);
          }
        };
        await assert.rejects(f.complete(), e => e.statusCode === 409);
        assert.equal(await mapping(), 'operator-changed-mapping'); assert.equal(await completed(), null);
      });

      await t.test('an approval edited after provider review cannot reuse the old proof snapshot', async () => {
        const f = await reset();
        hook = async sql => {
          if (sql === 'BEGIN') await pool.query(
            'UPDATE public.subscription_identity_reconciliations SET evidence_reference=$1 WHERE id=$2',
            ['changed-review-reference', authorizationId]);
        };
        await assert.rejects(f.complete(), e => e.statusCode === 409);
        assert.equal(await mapping(), fromId); assert.equal(await completed(), null);
      });

      await t.test('another account claiming the target at commit causes a safe uniqueness conflict', async () => {
        const f = await reset();
        hook = async sql => {
          if (sql.startsWith('UPDATE public."user"')) await pool.query(
            'UPDATE public."user" SET revenuecat_app_user_id=$1 WHERE user_id=99', [targetId]);
        };
        await assert.rejects(f.complete(), e => e.statusCode === 409);
        assert.equal(await mapping(), fromId); assert.equal(await completed(), null);
        assert.equal((await pool.query('SELECT revenuecat_app_user_id FROM public."user" WHERE user_id=99')).rows[0].revenuecat_app_user_id, targetId);
      });
    } finally {
      if (pool) await pool.end();
      if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', timeout: 10000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
