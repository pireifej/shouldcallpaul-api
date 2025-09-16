#!/usr/bin/env python3
"""
Create staging schema that exactly mirrors MariaDB structure
"""
import re
import os
import psycopg2

def extract_create_statements(sql_file):
    """Extract CREATE TABLE statements from MariaDB dump"""
    with open(sql_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find all CREATE TABLE statements
    pattern = r'CREATE TABLE `([^`]+)` \(\s*(.*?)\s*\) ENGINE=.*?;'
    matches = re.findall(pattern, content, re.DOTALL)
    
    tables = {}
    for table_name, table_def in matches:
        tables[table_name] = table_def.strip()
    
    return tables

def convert_column_definition(col_def):
    """Convert MariaDB column definition to PostgreSQL"""
    # Remove backticks
    col_def = col_def.replace('`', '')
    
    # Convert data types - order matters!
    conversions = [
        (r'tinyint\(1\)', 'SMALLINT'),  # Do this BEFORE int() conversion
        (r'int\(\d+\)', 'INTEGER'),
        (r'varchar\((\d+)\)', r'VARCHAR(\1)'),
        (r'\bmediumtext\b', 'TEXT'),
        (r'\blongtext\b', 'TEXT'),
        (r'\btinytext\b', 'TEXT'),
        (r'\btext\b', 'TEXT'),
        (r'\bdatetime\b', 'TIMESTAMP'),
        (r'\btimestamp\b', 'TIMESTAMP'),
        (r'\bunsigned\b', ''),  # Remove unsigned modifier
        (r'DEFAULT current_timestamp\(\)', 'DEFAULT CURRENT_TIMESTAMP'),
        (r'ON UPDATE current_timestamp\(\)', ''),  # Remove for now
    ]
    
    for pattern, replacement in conversions:
        col_def = re.sub(pattern, replacement, col_def, flags=re.IGNORECASE)
    
    # Remove AUTO_INCREMENT (we'll handle this separately)
    col_def = re.sub(r'\s+AUTO_INCREMENT', '', col_def, flags=re.IGNORECASE)
    
    return col_def

def generate_staging_ddl(tables):
    """Generate PostgreSQL DDL for staging tables"""
    ddl_statements = []
    
    # Create staging schema
    ddl_statements.append("DROP SCHEMA IF EXISTS staging CASCADE;")
    ddl_statements.append("CREATE SCHEMA staging;")
    ddl_statements.append("")
    
    for table_name, table_def in tables.items():
        # Split column definitions
        lines = [line.strip() for line in table_def.split('\n') if line.strip()]
        
        columns = []
        constraints = []
        
        for line in lines:
            line = line.rstrip(',')
            
            if line.upper().startswith('PRIMARY KEY'):
                # Handle primary key constraints
                pk_match = re.search(r'PRIMARY KEY \(([^)]+)\)', line, re.IGNORECASE)
                if pk_match:
                    pk_cols = pk_match.group(1).replace('`', '')
                    constraints.append(f"PRIMARY KEY ({pk_cols})")
            elif line.upper().startswith('KEY ') or line.upper().startswith('UNIQUE KEY'):
                # Skip regular keys and unique keys for staging (we'll add them later if needed)
                continue
            elif line.upper().startswith('CONSTRAINT'):
                # Skip foreign key constraints for now - add them separately later
                continue
            else:
                # Regular column definition
                converted = convert_column_definition(line)
                if converted.strip():
                    columns.append(f"  {converted}")
        
        # Create the table DDL
        table_ref = f'staging."{table_name}"' if table_name == 'user' else f'staging.{table_name}'
        
        ddl = f"CREATE TABLE {table_ref} (\n"
        ddl += ",\n".join(columns)
        
        if constraints:
            ddl += ",\n" + ",\n".join(f"  {constraint}" for constraint in constraints)
        
        ddl += "\n);"
        
        ddl_statements.append(ddl)
        ddl_statements.append("")
    
    return ddl_statements

def main():
    """Generate staging schema"""
    print("Extracting MariaDB table definitions...")
    tables = extract_create_statements('backup.sql')
    
    print(f"Found {len(tables)} tables:")
    for table_name in tables.keys():
        print(f"  - {table_name}")
    
    print("\nGenerating PostgreSQL DDL...")
    ddl_statements = generate_staging_ddl(tables)
    
    # Write to file
    with open('staging_schema.sql', 'w') as f:
        f.write('\n'.join(ddl_statements))
    
    print("Staging schema written to staging_schema.sql")
    
    # Execute the DDL
    DATABASE_URL = os.environ.get('DATABASE_URL')
    if DATABASE_URL:
        print("Creating staging schema in database...")
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        try:
            for statement in ddl_statements:
                if statement.strip():
                    cur.execute(statement)
            
            conn.commit()
            print("Staging schema created successfully!")
            
            # Verify tables were created
            cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'staging' ORDER BY table_name;")
            staging_tables = [row[0] for row in cur.fetchall()]
            print(f"Created {len(staging_tables)} staging tables:")
            for table in staging_tables:
                print(f"  - staging.{table}")
                
        except Exception as e:
            print(f"Error creating staging schema: {e}")
            conn.rollback()
        finally:
            cur.close()
            conn.close()

if __name__ == "__main__":
    main()