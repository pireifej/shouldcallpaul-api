import os
import subprocess
from flask import Flask, render_template_string
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)

# create the app
app = Flask(__name__)
# setup a secret key, required by sessions
app.secret_key = os.environ.get("SESSION_SECRET") or "a secret key"
# configure the database, relative to the app instance folder
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

# initialize the app with the extension
db.init_app(app)


@app.route('/')
def index():
    """Simple route to verify database connection"""
    try:
        # Test database connection
        with db.engine.connect() as conn:
            result = conn.execute(db.text("SELECT version()"))
            version = result.fetchone()[0]
        
        # Get table count
        with db.engine.connect() as conn:
            result = conn.execute(db.text("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'"))
            table_count = result.fetchone()[0]
        
        return render_template_string('''
        <h1>Database Connection Status</h1>
        <p><strong>Status:</strong> ✅ Connected</p>
        <p><strong>PostgreSQL Version:</strong> {{ version }}</p>
        <p><strong>Tables in database:</strong> {{ table_count }}</p>
        <hr>
        <h2>Database Import Status</h2>
        <p>Ready to import backup file when provided.</p>
        ''', version=version, table_count=table_count)
    except Exception as e:
        return render_template_string('''
        <h1>Database Connection Status</h1>
        <p><strong>Status:</strong> ❌ Error</p>
        <p><strong>Error:</strong> {{ error }}</p>
        ''', error=str(e))


@app.route('/import-backup')
def import_backup():
    """Route to trigger backup import"""
    return render_template_string('''
    <h1>Backup Import</h1>
    <p>Upload your backup file to the project root and refresh this page to import.</p>
    <a href="/">← Back to status</a>
    ''')


if __name__ == '__main__':
    with app.app_context():
        # Create any tables defined in models (if they exist)
        try:
            db.create_all()
        except Exception as e:
            print(f"Database setup error: {e}")
    
    app.run(host='0.0.0.0', port=5000, debug=True)