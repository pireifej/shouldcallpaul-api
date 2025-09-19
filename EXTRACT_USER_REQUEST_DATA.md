# USER_REQUEST DATA EXTRACTION GUIDE

## 🎯 COMPLETE IMPORT SOLUTION

### Current Status:
- ✅ **Development Database**: 169/2,659 records (6.4% complete) 
- ⏳ **Production Database**: 0/2,659 records (needs complete import)
- 📁 **Backup File**: backup-god.09-14-2025-19-41_1758296507222.sql

---

## 🔧 STEP 1: Extract User_Request Data from Backup

Use this command to extract ONLY the user_request data:

```bash
# Extract user_request table data (lines 2207-4866)
sed -n '2207,4866p' backup-god.09-14-2025-19-41_1758296507222.sql > user_request_extracted.sql
```

## 🔄 STEP 2: Convert MySQL to PostgreSQL Format

```bash
# Convert MySQL format to PostgreSQL format
sed -i 's/INSERT INTO `user_request` VALUES/INSERT INTO public.user_request (request_id, user_id, timestamp) VALUES/g' user_request_extracted.sql
sed -i 's/`//g' user_request_extracted.sql
```

---

## 🚀 STEP 3A: PRODUCTION DATABASE IMPORT

Execute this in your **production** PostgreSQL database:

```sql
-- Clear existing data
DELETE FROM public.user_request;

-- Then execute the contents of user_request_extracted.sql
-- This will import all 2,659 records

-- Verify import
SELECT COUNT(*) FROM public.user_request;
-- Expected result: 2659
```

---

## 💻 STEP 3B: DEVELOPMENT DATABASE IMPORT

Execute this in your **development** PostgreSQL database:

```sql
-- Clear existing data  
DELETE FROM public.user_request;

-- Then execute the contents of user_request_extracted.sql
-- This will import all 2,659 records

-- Verify import
SELECT COUNT(*) FROM public.user_request;
-- Expected result: 2659
```

---

## ✅ VERIFICATION QUERIES

After import, run these to verify:

```sql
SELECT 
    COUNT(*) as total_records,
    MIN(timestamp) as earliest_prayer,
    MAX(timestamp) as latest_prayer,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT request_id) as unique_requests
FROM public.user_request;

-- Expected Results:
-- total_records: 2659
-- earliest_prayer: 2021-10-23
-- latest_prayer: 2025-09-14  
-- unique_users: ~211
-- unique_requests: ~431
```

---

## 🎉 IMPACT AFTER IMPORT

Once completed, your prayer platform will have:

✅ **Proper Prayer Filtering**: `/getRequestFeed` will hide requests users already prayed for  
✅ **Accurate Prayer Counts**: `/getAllUsers` will show real prayer statistics  
✅ **Working Prayer History**: Users can see which requests they've prayed for  
✅ **Email Notifications**: `/prayFor` endpoint will work with proper prayer tracking

---

## 📞 Need Help?

If you encounter any issues:
1. Check that your backup file path is correct
2. Ensure you have proper database permissions  
3. Verify the sed commands worked correctly
4. Run the verification queries to confirm data integrity

Your prayer community data will be fully restored! 🙏