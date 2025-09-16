#!/usr/bin/env python3
import re
import os
import psycopg2
from psycopg2.extras import execute_values

def extract_insert_data(sql_file):
    """Extract INSERT statements and data from SQL dump"""
    
    with open(sql_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find all INSERT statements with their table names and values
    insert_pattern = r'INSERT INTO `([^`]+)` VALUES\s*\n((?:\([^)]*\),?\s*\n?)*);'
    
    inserts = {}
    for match in re.finditer(insert_pattern, content, re.MULTILINE | re.DOTALL):
        table_name = match.group(1)
        values_section = match.group(2)
        
        # Parse individual value tuples
        value_tuples = []
        # Split by ),( pattern but be careful with nested parentheses and quotes
        tuples_text = values_section.strip()
        
        # Simple approach: split by '),(' and then clean up
        if tuples_text.endswith(','):
            tuples_text = tuples_text[:-1]  # Remove trailing comma
            
        # Extract individual tuples
        tuple_pattern = r'\(([^)]*(?:\([^)]*\)[^)]*)*)\)'
        for tuple_match in re.finditer(tuple_pattern, tuples_text):
            tuple_content = tuple_match.group(1)
            value_tuples.append(tuple_content)
        
        inserts[table_name] = value_tuples
    
    return inserts

def parse_values(value_string):
    """Parse a comma-separated value string, handling quotes properly"""
    values = []
    current_value = ""
    in_quotes = False
    quote_char = None
    i = 0
    
    while i < len(value_string):
        char = value_string[i]
        
        if not in_quotes:
            if char in ('"', "'"):
                in_quotes = True
                quote_char = char
                current_value += char
            elif char == ',':
                values.append(current_value.strip())
                current_value = ""
            else:
                current_value += char
        else:
            if char == quote_char:
                # Check if it's escaped
                if i + 1 < len(value_string) and value_string[i + 1] == quote_char:
                    # Escaped quote
                    current_value += char
                    i += 1  # Skip next character
                    current_value += value_string[i]
                else:
                    # End of quoted string
                    in_quotes = False
                    quote_char = None
                    current_value += char
            else:
                current_value += char
        
        i += 1
    
    if current_value.strip():
        values.append(current_value.strip())
    
    return values

def clean_value(value):
    """Clean and convert value for PostgreSQL"""
    value = value.strip()
    
    if value.upper() == 'NULL':
        return None
    
    # Remove quotes and handle escaping
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1]
        # Unescape single quotes
        value = value.replace("\\'", "'")
        value = value.replace("''", "'")
        return value
    
    # Handle numbers
    try:
        if '.' in value:
            return float(value)
        else:
            return int(value)
    except ValueError:
        return value

def import_data():
    """Import data into PostgreSQL database"""
    
    # Get database connection from environment
    DATABASE_URL = os.environ.get('DATABASE_URL')
    if not DATABASE_URL:
        print("DATABASE_URL environment variable not found")
        return
    
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        # Extract data from backup file
        print("Extracting data from backup file...")
        inserts = extract_insert_data('backup.sql')
        
        # Define the import order (respecting foreign key dependencies)
        table_order = [
            'user', 'category', 'blog_article', 'family', 'request', 
            'blessings', 'meal', 'prayers', 'comments', 'rosary', 
            'settings', 'sponge', 'user_family', 'user_request', 'visitors'
        ]
        
        total_imported = 0
        
        for table_name in table_order:
            if table_name in inserts:
                print(f"Importing data into {table_name}...")
                
                # Disable auto-increment temporarily for tables with explicit IDs
                if table_name in ['user', 'category', 'blog_article', 'blessings', 'family', 'meal', 'request', 'prayers', 'comments', 'rosary', 'settings', 'sponge']:
                    # We need to temporarily allow explicit ID insertion
                    pass
                
                rows_imported = 0
                for value_tuple in inserts[table_name]:
                    try:
                        # Parse the values
                        raw_values = parse_values(value_tuple)
                        clean_values = [clean_value(v) for v in raw_values]
                        
                        # Create placeholders for the query
                        placeholders = ','.join(['%s'] * len(clean_values))
                        
                        # Use quoted table name for reserved words like 'user'
                        table_ref = f'"{table_name}"' if table_name == 'user' else table_name
                        
                        query = f"INSERT INTO {table_ref} VALUES ({placeholders})"
                        cur.execute(query, clean_values)
                        rows_imported += 1
                        
                    except Exception as e:
                        print(f"Error inserting row into {table_name}: {e}")
                        print(f"Raw values: {raw_values}")
                        continue
                
                print(f"Imported {rows_imported} rows into {table_name}")
                total_imported += rows_imported
                
                # Reset sequence for serial columns
                if table_name in ['user', 'category', 'blog_article', 'blessings', 'family', 'meal', 'request', 'prayers', 'comments', 'rosary', 'settings', 'sponge']:
                    try:
                        # Get the correct sequence name
                        if table_name == 'user':
                            seq_query = "SELECT setval('user_user_id_seq', (SELECT MAX(user_id) FROM \"user\"));"
                        elif table_name == 'blog_article':
                            seq_query = "SELECT setval('blog_article_id_seq', (SELECT MAX(id) FROM blog_article));"
                        else:
                            # Most tables follow the pattern tablename_primarykey_seq
                            primary_cols = {
                                'category': 'category_id',
                                'blessings': 'blessings_id', 
                                'family': 'id',
                                'meal': 'meal_id',
                                'request': 'request_id',
                                'prayers': 'prayer_id',
                                'comments': 'comments_id',
                                'rosary': 'rosary_id',
                                'settings': 'id',
                                'sponge': 'sponge_id'
                            }
                            
                            if table_name in primary_cols:
                                col_name = primary_cols[table_name]
                                seq_query = f"SELECT setval('{table_name}_{col_name}_seq', (SELECT MAX({col_name}) FROM {table_name}));"
                            
                        cur.execute(seq_query)
                        print(f"Reset sequence for {table_name}")
                    except Exception as e:
                        print(f"Warning: Could not reset sequence for {table_name}: {e}")
        
        conn.commit()
        print(f"\nData import completed! Total rows imported: {total_imported}")
        
    except Exception as e:
        print(f"Database connection error: {e}")
        if 'conn' in locals():
            conn.rollback()
    finally:
        if 'cur' in locals():
            cur.close()
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    import_data()