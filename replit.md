# Overview

This project is a MariaDB to PostgreSQL database migration tool with a Flask web application for monitoring the import process. The system consists of multiple Python scripts that handle different aspects of converting and importing data from MariaDB SQL dump files into PostgreSQL, along with a simple web interface to verify database connectivity and monitor the migration status.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Migration Components

The system uses a multi-script approach to handle the complexity of database migration:

**Conversion Layer**: The `convert_mariadb_to_postgres.py` script handles the initial SQL syntax conversion, transforming MariaDB-specific constructs (AUTO_INCREMENT, backticks, data types) into PostgreSQL-compatible format. This addresses the fundamental incompatibility between the two database systems' SQL dialects.

**Schema Management**: The `create_staging_schema.py` focuses on extracting and converting table structure definitions, ensuring the target PostgreSQL database has the correct schema before data import. This separation allows for better error handling and debugging of structural issues.

**Data Import Strategies**: Multiple import scripts implement different approaches to handle the complexity of importing data:
- `simple_import.py` - Basic row-by-row import for straightforward cases
- `robust_import.py` - Advanced tokenization for handling complex data with nested quotes and special characters
- `staging_import.py` - State machine-based tokenizer for the most complex data scenarios
- `targeted_import.py` - Table-specific import for granular control over the migration process

**Problem Addressed**: MariaDB and PostgreSQL have different SQL syntaxes, data types, and features. Direct import of MariaDB dumps into PostgreSQL fails due to these incompatibilities.

**Solution Rationale**: The multi-script approach allows for progressive complexity handling - starting with simple conversions and escalating to more sophisticated parsing when needed. This provides flexibility to handle different types of data complexity without over-engineering simple cases.

## Web Application Architecture

**Framework Choice**: Flask with SQLAlchemy ORM provides a lightweight web interface for monitoring the migration process without adding unnecessary complexity.

**Database Integration**: Uses PostgreSQL as the target database with connection pooling and health monitoring to ensure stable database operations during large data imports.

**Monitoring Interface**: Single-route application that displays database connectivity status, PostgreSQL version, and table count to verify migration progress.

## Data Processing Design

**Tokenization Strategy**: Progressive complexity in parsing SQL VALUES statements, from simple regex splitting to full state machine tokenization. This handles edge cases like nested quotes, escaped characters, and complex data types that commonly cause import failures.

**Error Handling**: Each import strategy can handle different levels of data complexity, allowing the system to fall back to more robust parsing when simpler methods fail.

**Transaction Management**: Row-level transaction handling in robust import scripts ensures data integrity and allows for partial recovery from import errors.

# External Dependencies

## Database Systems
- **PostgreSQL** - Target database system for the migration
- **MariaDB** - Source database (via SQL dump files, not direct connection)

## Python Libraries
- **Flask** - Web application framework for the monitoring interface
- **Flask-SQLAlchemy** - Database ORM and connection management
- **psycopg2** - PostgreSQL database adapter for direct database operations
- **SQLAlchemy** - Database abstraction layer with DeclarativeBase for modern SQLAlchemy patterns

## Environment Configuration
- **DATABASE_URL** - PostgreSQL connection string
- **SESSION_SECRET** - Flask session security key

## File Dependencies
- **backup.sql** - MariaDB SQL dump file (expected input file for migration)

The architecture assumes the presence of a MariaDB SQL dump file and requires a target PostgreSQL database instance for the migration destination.