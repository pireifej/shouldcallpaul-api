#!/usr/bin/env python3
"""
Robust data import with per-row transactions and proper value-level tokenization
"""
import os
import psycopg2
import re

class ValueTokenizer:
    """Tokenize a row tuple into individual values"""
    
    def tokenize_row_values(self, row_tuple):
        """Split a row tuple like (val1,val2,'string,with,commas',val4) into individual values"""
        if not row_tuple.startswith('(') or not row_tuple.endswith(')'):
            raise ValueError(f"Invalid row format: {row_tuple}")
        
        # Remove outer parentheses
        content = row_tuple[1:-1]
        
        values = []
        current_value = ""
        in_string = False
        escape_next = False
        quote_char = None
        
        i = 0
        while i < len(content):
            char = content[i]
            
            if escape_next:
                current_value += char
                escape_next = False
            elif char == '\\' and in_string:
                current_value += char
                escape_next = True
            elif not in_string and char in ("'", '"'):
                # Start of quoted string
                in_string = True
                quote_char = char
                current_value += char
            elif in_string and char == quote_char:
                # Check for doubled quote
                if i + 1 < len(content) and content[i + 1] == quote_char:
                    # Doubled quote - add both
                    current_value += char + char
                    i += 1  # Skip next quote
                else:
                    # End of string
                    in_string = False
                    quote_char = None
                    current_value += char
            elif not in_string and char == ',':
                # End of value
                values.append(current_value.strip())
                current_value = ""
            else:
                current_value += char
            
            i += 1
        
        # Add the last value
        if current_value.strip():
            values.append(current_value.strip())
        
        return values

def convert_value(value):
    """Convert a single value from MariaDB to PostgreSQL format"""
    value = value.strip()
    
    # Handle NULL
    if value.upper() == 'NULL':
        return 'NULL'
    
    # Handle numbers (not quoted)
    if not value.startswith("'") and not value.startswith('"'):
        return value
    
    # Handle quoted strings
    if value.startswith("'") and value.endswith("'"):
        inner = value[1:-1]
        
        # Handle zero dates - convert to NULL
        if inner in ['0000-00-00 00:00:00', '0000-00-00']:
            return 'NULL'
        
        # Check if we need E'' format (contains backslashes)
        if '\\' in inner:
            # Convert to E'' format for PostgreSQL
            # Keep backslash escapes as-is for \n, \t, etc.
            # Convert \' to '' for PostgreSQL
            converted = inner.replace("\\'", "''")
            # Double any remaining single quotes
            converted = converted.replace("'", "''")
            return f"E'{converted}'"
        else:
            # Regular string - just ensure quotes are doubled
            converted = inner.replace("''", "''")  # Already doubled quotes are fine
            converted = converted.replace("'", "''")  # Double any single quotes
            return f"'{converted}'"
    
    return value

def import_table_robust(table_name):
    """Import table data with per-row error handling"""
    print(f"Importing {table_name} (robust)...")
    
    # Read backup file
    with open('backup.sql', 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Extract INSERT statement
    pattern = rf'INSERT INTO `{table_name}` VALUES\s*\n(.*?);'
    match = re.search(pattern, content, re.DOTALL)
    
    if not match:
        print(f"  No INSERT data found for {table_name}")
        return 0
    
    values_section = match.group(1).strip()
    if values_section.endswith(','):
        values_section = values_section[:-1]
    
    # Use the original tokenizer to split into rows
    from staging_import import SQLTokenizer
    tokenizer = SQLTokenizer()
    rows = tokenizer.tokenize_values(values_section)
    
    if not rows:
        print(f"  No rows parsed for {table_name}")
        return 0
    
    # Database connection with autocommit for per-row transactions
    DATABASE_URL = os.environ.get('DATABASE_URL')
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True  # Each INSERT is its own transaction
    cur = conn.cursor()
    
    imported_count = 0
    errors = 0
    value_tokenizer = ValueTokenizer()
    
    for row_data in rows:
        try:
            # Tokenize the row into individual values
            values = value_tokenizer.tokenize_row_values(row_data)
            
            # Convert each value
            converted_values = []
            for value in values:
                converted_values.append(convert_value(value))
            
            # Build INSERT statement
            table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
            placeholders = ','.join(converted_values)
            insert_sql = f"INSERT INTO {table_ref} VALUES ({placeholders})"
            
            # Execute with individual transaction
            cur.execute(insert_sql)
            imported_count += 1
            
        except Exception as e:
            errors += 1
            if errors <= 5:  # Show first few errors for debugging
                print(f"  Error importing row: {e}")
                print(f"  Row: {row_data[:100]}...")
                if errors == 1:
                    print(f"  SQL: {insert_sql[:200]}...")
            continue
    
    cur.close()
    conn.close()
    
    print(f"  Successfully imported {imported_count} rows ({errors} errors)")
    return imported_count

def main():
    """Import all tables with robust error handling"""
    print("Starting robust staging import...")
    
    # Focus on the tables that had issues
    problem_tables = ['user', 'request', 'comments', 'visitors', 'prayers']
    
    # First, clear any partial data from failed imports
    DATABASE_URL = os.environ.get('DATABASE_URL')
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    
    for table_name in problem_tables:
        try:
            table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
            cur.execute(f"DELETE FROM {table_ref}")
            print(f"Cleared {table_name}")
        except:
            pass
    
    conn.commit()
    cur.close()
    conn.close()
    
    # Import each problematic table
    total_imported = 0
    for table_name in problem_tables:
        count = import_table_robust(table_name)
        total_imported += count
        print()
    
    print(f"Robust import completed! New rows: {total_imported}")
    
    # Final verification
    print("\nFinal staging verification...")
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    
    all_tables = ['user', 'request', 'blessings', 'category', 'comments', 'visitors', 'prayers']
    for table_name in all_tables:
        table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
        cur.execute(f"SELECT COUNT(*) FROM {table_ref}")
        count = cur.fetchone()[0]
        status = "✅" if count > 0 else "❌"
        expected = " (expected 393)" if table_name == 'request' else ""
        print(f"  {status} staging.{table_name}: {count} rows{expected}")
    
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()