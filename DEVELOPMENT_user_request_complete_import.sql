-- =========================================================================
-- COMPLETE USER_REQUEST IMPORT SCRIPT FOR DEVELOPMENT DATABASE
-- =========================================================================
-- This script completes the import of remaining user_request records
-- Current status: 169 records imported, 2,490 remaining
-- Execute this to complete the development database import
-- =========================================================================

-- Note: Extract the complete INSERT statement from backup-god.09-14-2025-19-41_1758296507222.sql
-- Lines 2208-4866 contain all the user_request data
-- 
-- Format conversion needed:
-- 1. Change: INSERT INTO `user_request` VALUES  
--    To:     INSERT INTO public.user_request (request_id, user_id, timestamp) VALUES
-- 2. Remove all backticks (`)
-- 3. Ensure proper PostgreSQL timestamp format

-- Clear existing data and start fresh with complete dataset
DELETE FROM public.user_request;

-- INSERT COMPLETE DATASET HERE (2,659 records)
-- [Extract and paste the complete INSERT statement from your backup file]

-- Verification query
SELECT 
    'DEVELOPMENT IMPORT COMPLETE' as status,
    COUNT(*) as total_records,
    MIN(timestamp) as earliest_prayer,
    MAX(timestamp) as latest_prayer,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT request_id) as unique_requests
FROM public.user_request;