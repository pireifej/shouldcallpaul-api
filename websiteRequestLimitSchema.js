'use strict';

// Importing this module never connects to a database or runs migrations.
async function ensureWebsiteRequestLimitSchema(name, dbPool) {
  await dbPool.query(
    `ALTER TABLE public."user"
     ADD COLUMN IF NOT EXISTS revenuecat_app_user_id TEXT`
  );
  const duplicateMappings = await dbPool.query(
    `SELECT COUNT(*)::int AS duplicate_count
     FROM (
       SELECT revenuecat_app_user_id
       FROM public."user"
       WHERE revenuecat_app_user_id IS NOT NULL
       GROUP BY revenuecat_app_user_id
       HAVING COUNT(*) > 1
     ) duplicates`
  );
  if (duplicateMappings.rows[0].duplicate_count > 0) {
    // Never guess ownership or reset customer links to make startup succeed.
    const error = new Error(
      'Duplicate RevenueCat account mappings detected; mappings were preserved. Startup requires manual review.'
    );
    error.code = 'REVENUECAT_MAPPING_CONFLICT';
    throw error;
  }
  await dbPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS user_revenuecat_app_user_id_unique_idx
     ON public."user" (revenuecat_app_user_id)
     WHERE revenuecat_app_user_id IS NOT NULL`
  );
  await dbPool.query(
    `ALTER TABLE public.request
     ADD COLUMN IF NOT EXISTS request_source VARCHAR(20) NOT NULL DEFAULT 'mobile'`
  );
  await dbPool.query(
    `ALTER TABLE public.request
     ADD COLUMN IF NOT EXISTS website_request_date DATE`
  );
  await dbPool.query('DROP INDEX IF EXISTS public.request_website_daily_unique_idx');
  console.log(`✅ Required website request-limit schema (${name}) ready`);
}

module.exports = { ensureWebsiteRequestLimitSchema };
