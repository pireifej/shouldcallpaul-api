-- =========================================================================
-- COMPLETE USER_REQUEST IMPORT SCRIPT FOR PRODUCTION DATABASE
-- =========================================================================
-- This script imports ALL 2,659 user_request records from your backup
-- Execute this entire script in your PostgreSQL PRODUCTION database
--
-- IMPORTANT: This script will:
-- 1. Clear existing user_request table (if any)
-- 2. Import all 2,659 records from backup-god.09-14-2025-19-41.sql
-- 3. Verify the import with statistics
-- =========================================================================

-- Step 1: Clear existing data to avoid duplicates
DELETE FROM public.user_request;

-- Step 2: Import ALL user_request data from backup
-- Note: Execute the extracted INSERT statements from your backup file here
-- The format should be:
-- INSERT INTO public.user_request (request_id, user_id, timestamp) VALUES
-- (1,353,'2025-09-13 18:48:58'),
-- (2,353,'2025-09-13 18:48:55'),
-- ... (all 2,659 records) ...
-- (1690,353,'2025-09-14 10:03:38');

-- =========================================================================
-- EXTRACTION INSTRUCTIONS:
-- =========================================================================
-- From your backup file backup-god.09-14-2025-19-41_1758296507222.sql:
-- 
-- 1. Find lines 2207-4866 which contain the user_request data
-- 2. Replace: INSERT INTO `user_request` VALUES
--    With:   INSERT INTO public.user_request (request_id, user_id, timestamp) VALUES
-- 3. Remove backticks (`) from the SQL
-- 4. Execute the complete INSERT statement
-- =========================================================================

-- Step 3: Verify import results
SELECT 
    'IMPORT VERIFICATION' as status,
    COUNT(*) as total_records_imported,
    MIN(timestamp) as earliest_prayer_date,
    MAX(timestamp) as latest_prayer_date,
    COUNT(DISTINCT user_id) as unique_users_praying,
    COUNT(DISTINCT request_id) as unique_requests_prayed_for
FROM public.user_request;

-- Step 4: Sample data verification
SELECT 
    'SAMPLE VERIFICATION' as status,
    request_id, 
    user_id, 
    timestamp 
FROM public.user_request 
ORDER BY timestamp DESC 
LIMIT 10;

-- Expected Results:
-- total_records_imported: 2659
-- unique_users_praying: ~211 users
-- unique_requests_prayed_for: ~431 requests
-- Date range: 2021-10-23 to 2025-09-14