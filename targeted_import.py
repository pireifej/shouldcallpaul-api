#!/usr/bin/env python3
import os
import psycopg2
import re

def get_db_connection():
    """Get database connection"""
    DATABASE_URL = os.environ.get('DATABASE_URL')
    return psycopg2.connect(DATABASE_URL)

def import_single_table(table_name):
    """Import data for a single table by extracting from original backup"""
    print(f"Processing {table_name}...")
    
    # Read the original backup file
    with open('backup.sql', 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Extract just the INSERT VALUES section for this table
    pattern = rf'INSERT INTO `{table_name}` VALUES\s*\n(.*?);'
    match = re.search(pattern, content, re.DOTALL)
    
    if not match:
        print(f"  No INSERT data found for {table_name}")
        return 0
    
    values_section = match.group(1).strip()
    
    # Split into individual rows using a more robust approach
    # The key is to handle the ),( pattern correctly
    if values_section.endswith(','):
        values_section = values_section[:-1]  # Remove trailing comma
    
    # Split by '),(' but preserve the parentheses for each row
    rows = []
    parts = values_section.split('),(')
    
    for i, part in enumerate(parts):
        if i == 0:
            # First part - should start with (
            if not part.startswith('('):
                part = '(' + part
            if not part.endswith(')'):
                part = part + ')'
        elif i == len(parts) - 1:
            # Last part - should end with )
            if not part.startswith('('):
                part = '(' + part
            if not part.endswith(')'):
                part = part + ')'
        else:
            # Middle parts - add both parentheses
            part = '(' + part + ')'
        
        rows.append(part)
    
    # Now import each row
    conn = get_db_connection()
    cur = conn.cursor()
    
    imported_count = 0
    errors = 0
    
    for row_data in rows:
        try:
            # Clean the row data for PostgreSQL
            clean_row = row_data
            
            # Handle table name quoting for reserved words
            table_ref = f'"{table_name}"' if table_name == 'user' else table_name
            
            # Create the INSERT statement
            insert_sql = f"INSERT INTO {table_ref} VALUES {clean_row}"
            
            # Execute the insert
            cur.execute(insert_sql)
            imported_count += 1
            
        except Exception as e:
            errors += 1
            if errors <= 3:  # Show first few errors for debugging
                print(f"  Error importing row: {e}")
                print(f"  Row data: {row_data[:100]}...")
    
    try:
        conn.commit()
        print(f"  Successfully imported {imported_count} rows ({errors} errors)")
        
        # Reset the sequence for tables with serial primary keys
        sequence_info = {
            'user': ('user_user_id_seq', 'user_id'),
            'category': ('category_category_id_seq', 'category_id'),
            'blog_article': ('blog_article_id_seq', 'id'),
            'blessings': ('blessings_blessings_id_seq', 'blessings_id'),
            'family': ('family_id_seq', 'id'),
            'meal': ('meal_meal_id_seq', 'meal_id'),
            'request': ('request_request_id_seq', 'request_id'),
            'prayers': ('prayers_prayer_id_seq', 'prayer_id'),
            'comments': ('comments_comments_id_seq', 'comments_id'),
            'rosary': ('rosary_rosary_id_seq', 'rosary_id'),
            'settings': ('settings_id_seq', 'id'),
            'sponge': ('sponge_sponge_id_seq', 'sponge_id')
        }
        
        if table_name in sequence_info:
            seq_name, col_name = sequence_info[table_name]
            table_ref = f'"{table_name}"' if table_name == 'user' else table_name
            cur.execute(f"SELECT setval('{seq_name}', (SELECT COALESCE(MAX({col_name}), 1) FROM {table_ref}));")
            conn.commit()
            print(f"  Reset sequence for {table_name}")
            
    except Exception as e:
        print(f"  Error committing changes: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()
    
    return imported_count

def main():
    """Import all tables in dependency order"""
    print("Starting targeted data import...")
    
    # Import tables in dependency order
    import_order = [
        'user',           # First - referenced by others
        'category',       # Independent
        'blog_article',   # Independent  
        'settings',       # Independent
        'visitors',       # Independent
        'family',         # References user
        'request',        # References user and category
        'blessings',      # References user
        'meal',           # References user
        'rosary',         # References user
        'sponge',         # References user
        'prayers',        # References user and request
        'comments',       # References user and request
        'user_family',    # References user and family
        'user_request',   # References user and request
    ]
    
    total_imported = 0
    
    for table_name in import_order:
        count = import_single_table(table_name)
        total_imported += count
        print()  # Add space between tables
    
    print(f"Import completed! Total rows imported: {total_imported}")
    
    # Final verification
    print("\nVerifying import results...")
    conn = get_db_connection()
    cur = conn.cursor()
    
    for table_name in ['user', 'request', 'blessings', 'category', 'comments']:
        table_ref = f'"{table_name}"' if table_name == 'user' else table_name
        cur.execute(f"SELECT COUNT(*) FROM {table_ref}")
        count = cur.fetchone()[0]
        print(f"  {table_name}: {count} rows")
    
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()