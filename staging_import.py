#!/usr/bin/env python3
"""
Robust data import with proper tokenization for MariaDB to PostgreSQL
"""
import os
import psycopg2
import re

class SQLTokenizer:
    """State machine tokenizer for handling complex SQL VALUES"""
    
    def __init__(self):
        self.reset()
    
    def reset(self):
        self.in_string = False
        self.escape_next = False
        self.paren_depth = 0
        self.quote_char = None
        self.current_token = ""
        self.tokens = []
    
    def tokenize_values(self, values_text):
        """Tokenize VALUES section into individual rows"""
        self.reset()
        rows = []
        current_row = ""
        
        i = 0
        while i < len(values_text):
            char = values_text[i]
            
            if self.escape_next:
                current_row += char
                self.escape_next = False
            elif char == '\\' and self.in_string:
                current_row += char
                self.escape_next = True
            elif not self.in_string and char in ("'", '"'):
                # Start of quoted string
                self.in_string = True
                self.quote_char = char
                current_row += char
            elif self.in_string and char == self.quote_char:
                # Check for escaped quote (doubled)
                if i + 1 < len(values_text) and values_text[i + 1] == self.quote_char:
                    # Doubled quote - add both
                    current_row += char + char
                    i += 1  # Skip next quote
                else:
                    # End of string
                    self.in_string = False
                    self.quote_char = None
                    current_row += char
            elif not self.in_string and char == '(':
                self.paren_depth += 1
                current_row += char
            elif not self.in_string and char == ')':
                self.paren_depth -= 1
                current_row += char
                
                # If we're at depth 0, we've completed a row
                if self.paren_depth == 0:
                    rows.append(current_row.strip())
                    current_row = ""
                    # Skip any following comma and whitespace
                    while i + 1 < len(values_text) and values_text[i + 1] in (',', ' ', '\n', '\t'):
                        i += 1
            else:
                current_row += char
            
            i += 1
        
        # Handle any remaining content
        if current_row.strip():
            rows.append(current_row.strip())
        
        return rows

def convert_string_value(value_str):
    """Convert MariaDB string to PostgreSQL format"""
    if not value_str.startswith("'") or not value_str.endswith("'"):
        return value_str
    
    # Remove outer quotes
    inner = value_str[1:-1]
    
    # Check if we need E'' format (has backslash escapes)
    if '\\' in inner:
        # Convert to E'' format
        # Replace \' with '' for PostgreSQL
        inner = inner.replace("\\'", "''")
        # Keep other backslash escapes as-is (\n, \t, etc.)
        return f"E'{inner}'"
    else:
        # Handle doubled quotes
        inner = inner.replace("''", "''")  # Already correct
        return f"'{inner}'"

def import_table_to_staging(table_name):
    """Import data for a single table into staging schema"""
    print(f"Importing {table_name} into staging...")
    
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
    
    # Use tokenizer to split into rows
    tokenizer = SQLTokenizer()
    rows = tokenizer.tokenize_values(values_section)
    
    if not rows:
        print(f"  No rows parsed for {table_name}")
        return 0
    
    # Import to database
    DATABASE_URL = os.environ.get('DATABASE_URL')
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    
    imported_count = 0
    errors = 0
    
    for row_data in rows:
        try:
            # Convert string values if needed
            converted_row = row_data
            
            # Simple conversion for strings with backslash escapes
            # Find quoted strings and convert them
            def replace_string(match):
                return convert_string_value(match.group(0))
            
            # Convert quoted strings
            converted_row = re.sub(r"'[^']*(?:''[^']*)*'", replace_string, converted_row)
            
            # Use staging table reference
            table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
            
            # Create INSERT statement
            insert_sql = f"INSERT INTO {table_ref} VALUES {converted_row}"
            
            # Execute
            cur.execute(insert_sql)
            imported_count += 1
            
        except Exception as e:
            errors += 1
            if errors <= 3:  # Show first few errors
                print(f"  Error importing row: {e}")
                print(f"  Row: {row_data[:100]}...")
            continue
    
    try:
        conn.commit()
        print(f"  Successfully imported {imported_count} rows ({errors} errors)")
    except Exception as e:
        print(f"  Error committing: {e}")
        conn.rollback()
    finally:
        cur.close()
        conn.close()
    
    return imported_count

def main():
    """Import all tables into staging"""
    print("Starting staging data import with tokenizer...")
    
    # Import in dependency order
    tables = [
        'user', 'category', 'blog_article', 'settings', 'visitors',
        'family', 'request', 'blessings', 'meal', 'rosary', 'sponge',
        'prayers', 'comments', 'user_family', 'user_request'
    ]
    
    total_imported = 0
    
    for table_name in tables:
        count = import_table_to_staging(table_name)
        total_imported += count
        print()
    
    print(f"Staging import completed! Total rows: {total_imported}")
    
    # Verify import
    print("\nVerifying staging import...")
    DATABASE_URL = os.environ.get('DATABASE_URL')
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    
    verification_tables = ['user', 'request', 'blessings', 'category', 'comments']
    for table_name in verification_tables:
        table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
        cur.execute(f"SELECT COUNT(*) FROM {table_ref}")
        count = cur.fetchone()[0]
        print(f"  staging.{table_name}: {count} rows")
    
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()