#!/usr/bin/env python3
import re
import sys

def convert_mariadb_to_postgres(input_file, output_file):
    """Convert MariaDB SQL dump to PostgreSQL compatible format"""
    
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Remove MariaDB-specific comments and version checks
    content = re.sub(r'/\*!\d+.*?\*/', '', content, flags=re.DOTALL)
    
    # Remove LOCK TABLES statements
    content = re.sub(r'LOCK TABLES.*?;', '', content, flags=re.IGNORECASE)
    content = re.sub(r'UNLOCK TABLES;', '', content, flags=re.IGNORECASE)
    
    # Remove DISABLE/ENABLE KEYS statements
    content = re.sub(r'ALTER TABLE.*?DISABLE KEYS.*?;', '', content, flags=re.IGNORECASE)
    content = re.sub(r'ALTER TABLE.*?ENABLE KEYS.*?;', '', content, flags=re.IGNORECASE)
    
    # Remove backticks from table and column names
    content = re.sub(r'`([^`]+)`', r'\1', content)
    
    # Convert AUTO_INCREMENT to SERIAL
    # First handle PRIMARY KEY columns with AUTO_INCREMENT
    content = re.sub(r'(\w+)\s+int\(\d+\)\s+NOT NULL AUTO_INCREMENT,\s*PRIMARY KEY \(\1\)', 
                    r'\1 SERIAL PRIMARY KEY', content, flags=re.IGNORECASE)
    
    # Handle remaining AUTO_INCREMENT columns
    content = re.sub(r'int\(\d+\)\s+NOT NULL AUTO_INCREMENT', 'SERIAL', content, flags=re.IGNORECASE)
    content = re.sub(r'int\(\d+\)\s+AUTO_INCREMENT', 'SERIAL', content, flags=re.IGNORECASE)
    
    # Convert data types
    content = re.sub(r'int\(\d+\)', 'INTEGER', content, flags=re.IGNORECASE)
    content = re.sub(r'tinyint\(1\)', 'BOOLEAN', content, flags=re.IGNORECASE)
    content = re.sub(r'\btimestamp\b', 'TIMESTAMP', content, flags=re.IGNORECASE)
    content = re.sub(r'\bdatetime\b', 'TIMESTAMP', content, flags=re.IGNORECASE)
    
    # Convert current_timestamp() to CURRENT_TIMESTAMP
    content = re.sub(r'current_timestamp\(\)', 'CURRENT_TIMESTAMP', content, flags=re.IGNORECASE)
    content = re.sub(r'DEFAULT current_timestamp', 'DEFAULT CURRENT_TIMESTAMP', content, flags=re.IGNORECASE)
    
    # Remove ENGINE and CHARSET specifications
    content = re.sub(r'\)\s*ENGINE=\w+.*?;', ');', content, flags=re.IGNORECASE)
    
    # Handle KEY statements (convert to CREATE INDEX)
    # For now, just remove them as PostgreSQL will handle indexes differently
    content = re.sub(r',\s*KEY\s+\w+\s+\([^)]+\)', '', content, flags=re.IGNORECASE)
    
    # Fix INSERT statements that might have issues with SERIAL columns
    # PostgreSQL SERIAL columns should use DEFAULT or be omitted
    
    # Clean up extra whitespace and empty lines
    content = re.sub(r'\n\s*\n\s*\n', '\n\n', content)
    content = re.sub(r',\s*\)', ')', content)  # Remove trailing commas before closing parentheses
    
    # Add PostgreSQL-specific settings at the beginning
    postgres_header = """-- Converted from MariaDB to PostgreSQL
SET client_encoding = 'UTF8';
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

"""
    
    content = postgres_header + content
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"Conversion completed: {input_file} -> {output_file}")

if __name__ == "__main__":
    convert_mariadb_to_postgres("backup.sql", "backup_postgres.sql")