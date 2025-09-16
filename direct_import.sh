#!/bin/bash

# Direct SQL import script for MariaDB to PostgreSQL

echo "Cleaning and importing data directly..."

# Create a clean version of the SQL file for PostgreSQL
cp backup.sql clean_backup.sql

# Remove MariaDB-specific comments and settings
sed -i '/\/\*!/d' clean_backup.sql
sed -i '/LOCK TABLES/d' clean_backup.sql
sed -i '/UNLOCK TABLES/d' clean_backup.sql
sed -i '/ALTER TABLE.*DISABLE KEYS/d' clean_backup.sql
sed -i '/ALTER TABLE.*ENABLE KEYS/d' clean_backup.sql
sed -i '/SET.*=/d' clean_backup.sql

# Remove backticks from table and column names
sed -i 's/`//g' clean_backup.sql

# Fix "user" table name (reserved word in PostgreSQL)
sed -i 's/REFERENCES user (/REFERENCES "user" (/g' clean_backup.sql
sed -i 's/INSERT INTO user VALUES/INSERT INTO "user" VALUES/g' clean_backup.sql
sed -i 's/DROP TABLE IF EXISTS user;/DROP TABLE IF EXISTS "user";/g' clean_backup.sql

# Convert AUTO_INCREMENT columns - remove them since we already have SERIAL
sed -i 's/) ENGINE=InnoDB[^;]*;/);/g' clean_backup.sql

# Remove CREATE TABLE statements since tables already exist
sed -i '/^CREATE TABLE/,/^);$/d' clean_backup.sql
sed -i '/^DROP TABLE/d' clean_backup.sql

echo "Importing data into PostgreSQL..."
psql "$DATABASE_URL" -f clean_backup.sql

echo "Import completed!"

# Check row counts
echo "Checking row counts..."
psql "$DATABASE_URL" -c "
SELECT 
    'user' as table_name, 
    COUNT(*) as row_count 
FROM \"user\"
UNION ALL
SELECT 
    'request' as table_name, 
    COUNT(*) as row_count 
FROM request
UNION ALL
SELECT 
    'blessings' as table_name, 
    COUNT(*) as row_count 
FROM blessings
UNION ALL
SELECT 
    'category' as table_name, 
    COUNT(*) as row_count 
FROM category
UNION ALL
SELECT 
    'comments' as table_name, 
    COUNT(*) as row_count 
FROM comments
ORDER BY table_name;
"