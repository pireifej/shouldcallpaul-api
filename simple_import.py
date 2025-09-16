#!/usr/bin/env python3
import os
import psycopg2
import re

def get_db_connection():
    """Get database connection"""
    DATABASE_URL = os.environ.get('DATABASE_URL')
    return psycopg2.connect(DATABASE_URL)

def extract_table_data(filename, table_name):
    """Extract INSERT data for a specific table"""
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find the INSERT statement for this table
    pattern = rf'INSERT INTO `{table_name}` VALUES\s*\n(.*?);'
    match = re.search(pattern, content, re.DOTALL)
    
    if match:
        values_text = match.group(1).strip()
        return values_text
    return None

def convert_mariadb_values_to_postgres(values_text, table_name):
    """Convert MariaDB VALUES to PostgreSQL format"""
    if not values_text:
        return []
    
    # Remove trailing comma if present
    if values_text.endswith(','):
        values_text = values_text[:-1]
    
    # Split into individual rows - this is tricky with nested quotes
    rows = []
    
    # Use a simple approach: split by '),(' pattern
    # First, temporarily replace the pattern with a delimiter
    temp_delimiter = "||ROW_SEPARATOR||"
    values_text = values_text.replace('),(', temp_delimiter)
    
    # Remove outer parentheses
    if values_text.startswith('(') and values_text.endswith(')'):
        values_text = values_text[1:-1]
    
    # Split by our delimiter
    raw_rows = values_text.split(temp_delimiter)
    
    for raw_row in raw_rows:
        if raw_row.strip():
            rows.append(f"({raw_row})")
    
    return rows

def import_table_data(table_name, expected_columns):
    """Import data for a specific table"""
    print(f"Importing {table_name}...")
    
    # Extract data from backup file
    values_text = extract_table_data('backup.sql', table_name)
    if not values_text:
        print(f"  No data found for {table_name}")
        return 0
    
    # Convert to PostgreSQL format
    rows = convert_mariadb_values_to_postgres(values_text, table_name)
    
    if not rows:
        print(f"  No rows parsed for {table_name}")
        return 0
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    imported_count = 0
    
    try:
        for row in rows:
            try:
                # Create the INSERT statement
                table_ref = f'"{table_name}"' if table_name == 'user' else table_name
                placeholders = ','.join(['%s'] * expected_columns)
                
                # Parse values from the row string
                # Remove outer parentheses
                row_content = row[1:-1] if row.startswith('(') and row.endswith(')') else row
                
                # Very simple value parsing - split by comma but respect quotes
                values = []
                current_val = ""
                in_quotes = False
                quote_char = None
                i = 0
                
                while i < len(row_content):
                    char = row_content[i]
                    
                    if not in_quotes:
                        if char in ("'", '"'):
                            in_quotes = True
                            quote_char = char
                            current_val += char
                        elif char == ',':
                            # End of value
                            val = current_val.strip()
                            if val.upper() == 'NULL':
                                values.append(None)
                            elif val.startswith("'") and val.endswith("'"):
                                # String value - remove quotes and unescape
                                clean_val = val[1:-1].replace("\\'", "'").replace("''", "'")
                                values.append(clean_val)
                            else:
                                # Number or other value
                                try:
                                    if '.' in val:
                                        values.append(float(val))
                                    else:
                                        values.append(int(val))
                                except ValueError:
                                    values.append(val)
                            current_val = ""
                        else:
                            current_val += char
                    else:
                        if char == quote_char:
                            # Check for escaped quote
                            if i + 1 < len(row_content) and row_content[i + 1] == quote_char:
                                current_val += char
                                i += 1
                                current_val += row_content[i]
                            else:
                                # End of quoted string
                                in_quotes = False
                                quote_char = None
                                current_val += char
                        else:
                            current_val += char
                    
                    i += 1
                
                # Handle the last value
                if current_val.strip():
                    val = current_val.strip()
                    if val.upper() == 'NULL':
                        values.append(None)
                    elif val.startswith("'") and val.endswith("'"):
                        clean_val = val[1:-1].replace("\\'", "'").replace("''", "'")
                        values.append(clean_val)
                    else:
                        try:
                            if '.' in val:
                                values.append(float(val))
                            else:
                                values.append(int(val))
                        except ValueError:
                            values.append(val)
                
                # Insert the row
                query = f"INSERT INTO {table_ref} VALUES ({','.join(['%s'] * len(values))})"
                cur.execute(query, values)
                imported_count += 1
                
            except Exception as e:
                print(f"  Error importing row: {e}")
                print(f"  Row: {row[:100]}...")
                continue
        
        conn.commit()
        print(f"  Successfully imported {imported_count} rows")
        
        # Reset sequence if needed
        if table_name in ['user', 'category', 'blog_article', 'blessings', 'family', 'meal', 'request', 'prayers', 'comments', 'rosary', 'settings', 'sponge']:
            try:
                if table_name == 'user':
                    cur.execute("SELECT setval('user_user_id_seq', (SELECT COALESCE(MAX(user_id), 1) FROM \"user\"));")
                elif table_name == 'blog_article':
                    cur.execute("SELECT setval('blog_article_id_seq', (SELECT COALESCE(MAX(id), 1) FROM blog_article));")
                else:
                    # Standard pattern
                    seq_mapping = {
                        'category': ('category_category_id_seq', 'category_id'),
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
                    
                    if table_name in seq_mapping:
                        seq_name, col_name = seq_mapping[table_name]
                        cur.execute(f"SELECT setval('{seq_name}', (SELECT COALESCE(MAX({col_name}), 1) FROM {table_name}));")
                
                conn.commit()
                print(f"  Reset sequence for {table_name}")
            except Exception as e:
                print(f"  Warning: Could not reset sequence for {table_name}: {e}")
        
    except Exception as e:
        print(f"  Error processing {table_name}: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()
    
    return imported_count

def main():
    """Main import function"""
    print("Starting data import...")
    
    # Table definitions with expected column counts (approximate)
    tables_to_import = [
        ('user', 25),           # Import users first (referenced by other tables)
        ('category', 3),        # Categories next
        ('blog_article', 6),    # Independent table
        ('settings', 4),        # Independent table
        ('visitors', 5),        # Independent table
        ('family', 6),          # References user
        ('request', 18),        # References user and category  
        ('blessings', 5),       # References user
        ('meal', 5),            # References user
        ('rosary', 5),          # References user
        ('sponge', 5),          # References user
        ('prayers', 5),         # References user and request
        ('comments', 5),        # References user and request
        ('user_family', 3),     # References user and family
        ('user_request', 3),    # References user and request
    ]
    
    total_imported = 0
    
    for table_name, expected_cols in tables_to_import:
        count = import_table_data(table_name, expected_cols)
        total_imported += count
    
    print(f"\nData import completed! Total rows imported: {total_imported}")

if __name__ == "__main__":
    main()