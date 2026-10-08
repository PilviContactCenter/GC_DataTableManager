from flask import Flask, render_template, request, session, redirect, url_for, flash, abort, send_file
import list_tables
import pandas as pd
import os
import json
import io
from functools import wraps
from models import db, User, AppConfig, TablePermission, ColumnPermission, AuditLog
from dotenv import load_dotenv
from sqlalchemy import text
from flask_wtf.csrf import CSRFProtect
from werkzeug.security import generate_password_hash, check_password_hash
from row_validation import parse_row_form

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'dev_secret_key_12345')

# Determine Database Path based on OS
if os.name == 'nt':
    # Windows
    DATA_DIR = r'C:\PilviContactCenter'
else:
    # macOS / Linux
    DATA_DIR = os.path.expanduser('~/PilviContactCenter')

# Ensure directory exists
if not os.path.exists(DATA_DIR):
    try:
        os.makedirs(DATA_DIR)
    except OSError as e:
        print(f"Could not create data directory {DATA_DIR}: {e}")
        # Fallback to current directory
        DATA_DIR = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(DATA_DIR, 'genesys_manager.db')
print(f"Using Database at: {DB_PATH}")

# SQLAlchemy URI
# On Unix, absolute path starts with /, so sqlite:////path
# On Windows, absolute path starts with Drive:, so sqlite:///Drive:/path
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_PATH}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

print("Initializing Database...")
csrf = CSRFProtect(app)

db.init_app(app)

# Initialize DB and Config
with app.app_context():
    print("Creating database tables...")
    db.create_all()
    print("Database tables created.")
    
    # Migration: Check if AppConfig has 'name' and 'is_active' columns
    try:
        print("Checking migrations...")
        with db.engine.connect() as conn:
            # SQLite specific check
            result = conn.execute(text("PRAGMA table_info(app_config)")).fetchall()
            columns = [row[1] for row in result]
            
            if 'name' not in columns:
                print("Migrating AppConfig: Adding 'name' column")
                conn.execute(text("ALTER TABLE app_config ADD COLUMN name VARCHAR(100) DEFAULT 'Default'"))
                
            if 'is_active' not in columns:
                print("Migrating AppConfig: Adding 'is_active' column")
                conn.execute(text("ALTER TABLE app_config ADD COLUMN is_active BOOLEAN DEFAULT 0"))
                # Set the first one to active if none are active
                conn.execute(text("UPDATE app_config SET is_active = 1 WHERE id = (SELECT id FROM app_config LIMIT 1)"))
                conn.commit()
        print("Migrations checked.")
    except Exception as e:
        print(f"Migration check failed: {e}")

    # Check if config exists, if not try to load from .env
    print("Checking configuration...")
    config = AppConfig.query.filter_by(is_active=True).first()
    if not config:
        # Try to find ANY config
        config = AppConfig.query.first()
        if not config:
            print("No config found in DB. Checking .env...")
            load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))
            client_id = os.getenv('CLIENT_ID')
            client_secret = os.getenv('CLIENT_SECRET')
            if client_id and client_secret:
                config = AppConfig(name='Default', client_id=client_id, client_secret=client_secret, region='eu_central_1', is_active=True)
                db.session.add(config)
                db.session.commit()
                print("Initialized AppConfig from .env")
            else:
                print("No credentials in .env")
        else:
            # If config exists but none active, set first to active
            config.is_active = True
            db.session.commit()
            print("Activated existing config.")
    
    if config:
        print("Setting credentials...")
        list_tables.set_credentials(config.client_id, config.client_secret, config.region)
        print("Authenticating...")
        list_tables.authenticate()
        print("Authenticated.")
    
    # Create default users if not exist
    print("Checking default users...")
    if not User.query.first():
        print("No users found. Setup required.")
    else:
        print("Users exist.")
    print("Startup complete.")

def log_audit(user_id, action, target, details=None, previous_state=None, new_state=None):
    try:
        prev_json = json.dumps(previous_state) if previous_state else None
        new_json = json.dumps(new_state) if new_state else None
        
        log = AuditLog(user_id=user_id, action=action, target=target, details=details, 
                       previous_state=prev_json, new_state=new_json)
        db.session.add(log)
        db.session.commit()
    except Exception as e:
        print(f"Failed to create audit log: {e}")

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'logged_in' not in session:
            print("Session 'logged_in' not found, redirecting to login") # Debug print
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get('role') != 'admin':
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

@app.before_request
def check_setup():
    # Allow static files and setup route
    if request.endpoint in ['static', 'setup']:
        return
        
    # Check if any user exists
    if not User.query.first():
        return redirect(url_for('setup'))

@app.route('/setup', methods=['GET', 'POST'])
def setup():
    if User.query.first():
        flash('Setup already completed.', 'info')
        return redirect(url_for('login'))
        
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        
        # Optional Config
        env_name = request.form.get('env_name')
        region = request.form.get('region')
        client_id = request.form.get('client_id')
        client_secret = request.form.get('client_secret')
        
        if not email or not password:
            flash('Email and Password are required.', 'error')
            return render_template('setup.html')
            
        try:
            # Create Admin User
            admin = User(email=email, role='admin')
            admin.set_password(password)
            db.session.add(admin)
            
            # Create Config if provided
            if client_id and client_secret:
                config = AppConfig(name=env_name or 'Default', 
                                   client_id=client_id, 
                                   client_secret=client_secret, 
                                   region=region, 
                                   is_active=True)
                db.session.add(config)
                
                # Set runtime credentials
                list_tables.set_credentials(client_id, client_secret, region)
                list_tables.authenticate()
                
            db.session.commit()
            
            flash('Setup completed successfully! Please login.', 'success')
            return redirect(url_for('login'))
            
        except Exception as e:
            flash(f'Setup failed: {e}', 'error')
            
    return render_template('setup.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        
        user = User.query.filter_by(email=email).first()
        
        if user:
            # Check if password is correct (hashed)
            if user.check_password(password):
                session['logged_in'] = True
                session['user_id'] = user.id
                session['email'] = user.email
                session['role'] = user.role
                session.permanent = True
                return redirect(url_for('index'))
            # Fallback: Check if password is correct (plain text) - Lazy Migration
            elif user.password == password:
                # It matched plain text, so let's hash it and save
                user.set_password(password)
                db.session.commit()
                print(f"Migrated password for user {user.email} to hash.")
                
                session['logged_in'] = True
                session['user_id'] = user.id
                session['email'] = user.email
                session['role'] = user.role
                session.permanent = True
                return redirect(url_for('index'))
            else:
                flash('Invalid credentials. Please try again.', 'error')
        else:
            flash('Invalid credentials. Please try again.', 'error')
            
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def index():
    # Check if credentials are configured
    if not list_tables.CLIENT_ID or not list_tables.CLIENT_SECRET:
        if session.get('role') == 'admin':
            flash('Genesys Cloud credentials are not configured. Please set them in the App Configuration.', 'warning')
            return redirect(url_for('admin_config'))
        else:
            flash('System is not configured. Please contact an administrator.', 'error')
            return render_template('index.html', tables=[], user_role=session.get('role'))

    all_tables = list_tables.list_data_tables()
    user_role = session.get('role')
    
    if user_role == 'admin':
        tables = all_tables
    else:
        # Filter tables based on permissions
        user_id = session.get('user_id')
        perms = TablePermission.query.filter_by(user_id=user_id).all()
        allowed_table_ids = {p.table_id for p in perms}
        
        tables = [t for t in all_tables if t['Id'] in allowed_table_ids]
        
    return render_template('index.html', tables=tables, user_role=user_role)

@app.route('/table/<table_id>')
@login_required
def view_table(table_id):
    user_id = session.get('user_id')
    role = session.get('role')
    
    # Fetch schema to know data types
    full_schema = list_tables.get_table_schema(table_id)
    schema_props = full_schema.get('properties', {}) if full_schema else {}
    required_columns = (full_schema.get('required') or []) if full_schema else []

    if role == 'admin':
        columns_perms = {} 
        can_update = True
    else:
        # Fetch permissions from DB
        perm = TablePermission.query.filter_by(user_id=user_id, table_id=table_id).first()
        if perm:
            # Allow update if explicitly granted OR if any column has write permission
            has_write_col = any(cp.access_level == 'write' for cp in perm.column_permissions)
            can_update = perm.can_update_rows or has_write_col
            
            # Determine column permissions
            columns_perms = {}
            
            # If global read is on, default all to read
            if perm.can_read_rows:
                for col in schema_props.keys():
                    columns_perms[col] = 'read'
            
            # If global update is on, default all to write
            if perm.can_update_rows:
                for col in schema_props.keys():
                    columns_perms[col] = 'write'
            
            # Apply specific column permissions (overrides)
            for cp in perm.column_permissions:
                columns_perms[cp.column_name] = cp.access_level
                
        else:
            # User has no permission for this table at all
            abort(403)
        
    try:
        df = list_tables.get_table_rows(table_id)
        if df is not None and not df.empty:
            rows = df.to_dict(orient='records')
            return render_template('table_details.html', 
                                   rows=rows, 
                                   table_id=table_id,
                                   can_update=can_update,
                                   columns_perms=columns_perms,
                                   user_role=role,
                                   schema=schema_props,
                                   required_columns=required_columns)
        else:
            return render_template('table_details.html', 
                                   rows=[], 
                                   table_id=table_id,
                                   error="No data found or error fetching data.",
                                   user_role=role,
                                   can_update=can_update,
                                   columns_perms=columns_perms,
                                   schema=schema_props,
                                   required_columns=required_columns)
    except Exception as e:
        return render_template('table_details.html', 
                               rows=[], 
                               error=str(e), 
                               user_role=role, 
                               can_update=can_update,
                               columns_perms=columns_perms,
                               schema=schema_props,
                               required_columns=required_columns)

@app.route('/table/<table_id>/update', methods=['POST'])
@login_required
def update_row(table_id):
    user_id = session.get('user_id')
    role = session.get('role')
    
    # Check Table Permission
    if role != 'admin':
        perm = TablePermission.query.filter_by(user_id=user_id, table_id=table_id).first()
        
        has_write_col = False
        if perm:
            has_write_col = any(cp.access_level == 'write' for cp in perm.column_permissions)
            
        if not perm or (not perm.can_update_rows and not has_write_col):
            abort(403)
            
    row_key = request.form.get('row_key')
    if not row_key:
        flash('Row key missing', 'error')
        return redirect(url_for('view_table', table_id=table_id))
        
    # Fetch existing row to preserve data for read-only/hidden columns
    existing_row = list_tables.get_table_row(table_id, row_key)
    if not existing_row:
        flash('Row not found', 'error')
        return redirect(url_for('view_table', table_id=table_id))
        
    # Get Schema
    full_schema = list_tables.get_table_schema(table_id)
    properties = full_schema.get('properties', {}) if full_schema else {}
    required = full_schema.get('required', []) if full_schema else []
    
    # Get Column Permissions if not admin
    col_perms = {}
    if role != 'admin':
        perm = TablePermission.query.filter_by(user_id=user_id, table_id=table_id).first()
        
        # If global update is on, everything is write by default
        if perm.can_update_rows:
            for col in properties.keys():
                col_perms[col] = 'write'
        
        # Apply specific overrides
        for cp in perm.column_permissions:
            col_perms[cp.column_name] = cp.access_level
        
    writable_columns = None if role == 'admin' else {
        name for name, access in col_perms.items() if access == 'write'
    }
    updated_data, errors = parse_row_form(
        properties, request.form, existing=existing_row,
        writable_columns=writable_columns, required=required,
    )
    if errors:
        for error in errors:
            flash(error, 'error')
        return redirect(url_for('view_table', table_id=table_id))
                    
    try:
        list_tables.update_table_row(table_id, row_key, updated_data)
        log_audit(user_id, 'UPDATE_ROW', f"{table_id}|{row_key}", f"Updated row", 
                  previous_state=existing_row, new_state=updated_data)
        flash('Row updated successfully', 'success')
    except Exception as e:
        flash(f'Error updating row: {e}', 'error')
        
    return redirect(url_for('view_table', table_id=table_id))

@app.route('/table/<table_id>/create', methods=['POST'])
@login_required
@admin_required
def create_row(table_id):
    user_id = session.get('user_id')
    
    # Get Schema to know types
    full_schema = list_tables.get_table_schema(table_id)
    properties = full_schema.get('properties', {}) if full_schema else {}
    required = full_schema.get('required', []) if full_schema else []
    
    # The key is the immutable row identifier.
    row_key = (request.form.get('key') or '').strip()
    if not row_key:
        flash('Row Key is required.', 'error')
        return redirect(url_for('view_table', table_id=table_id))

    new_row_data, errors = parse_row_form(
        properties, request.form, required=required,
    )
    if errors:
        for error in errors:
            flash(error, 'error')
        return redirect(url_for('view_table', table_id=table_id))
    new_row_data['key'] = row_key
                    
    try:
        list_tables.create_table_row(table_id, new_row_data)
        log_audit(user_id, 'CREATE_ROW', f"{table_id}|{row_key}", f"Created row", new_state=new_row_data)
        flash('Row created successfully', 'success')
    except Exception as e:
        flash(f'Error creating row: {e}', 'error')
        
    return redirect(url_for('view_table', table_id=table_id))

@app.route('/table/<table_id>/delete/<row_key>', methods=['POST'])
@login_required
@admin_required
def delete_row(table_id, row_key):
    user_id = session.get('user_id')
    
    # Fetch row first for audit log
    existing_row = list_tables.get_table_row(table_id, row_key)
    
    try:
        list_tables.delete_table_row(table_id, row_key)
        log_audit(user_id, 'DELETE_ROW', f"{table_id}|{row_key}", f"Deleted row", previous_state=existing_row)
        flash('Row deleted successfully', 'success')
    except Exception as e:
        flash(f'Error deleting row: {e}', 'error')
        
    return redirect(url_for('view_table', table_id=table_id))

@app.route('/table/<table_id>/backup')
@login_required
@admin_required
def backup_table(table_id):
    try:
        df = list_tables.get_table_rows(table_id)
        if df is not None and not df.empty:
            # Convert to JSON string
            json_str = df.to_json(orient='records', indent=4)
            
            # Create a file-like buffer
            mem = io.BytesIO()
            mem.write(json_str.encode('utf-8'))
            mem.seek(0)
            
            return send_file(
                mem,
                as_attachment=True,
                download_name=f"{table_id}_backup.json",
                mimetype='application/json'
            )
        else:
            flash('No data to backup.', 'warning')
            return redirect(url_for('view_table', table_id=table_id))
    except Exception as e:
        flash(f'Backup failed: {str(e)}', 'error')
        return redirect(url_for('view_table', table_id=table_id))

@app.route('/table/<table_id>/restore', methods=['POST'])
@login_required
@admin_required
def restore_table(table_id):
    if 'backup_file' not in request.files:
        flash('No file part', 'error')
        return redirect(url_for('view_table', table_id=table_id))
        
    file = request.files['backup_file']
    if file.filename == '':
        flash('No selected file', 'error')
        return redirect(url_for('view_table', table_id=table_id))
        
    if file:
        try:
            data = json.load(file)
            if not isinstance(data, list):
                flash('Invalid JSON format. Expected a list of records.', 'error')
                return redirect(url_for('view_table', table_id=table_id))
            
            success_count = 0
            error_count = 0
            
            for row in data:
                # Identify key
                row_key = row.get('key') or row.get('id')
                if not row_key:
                    # Try to find key from schema if possible, or skip
                    # For now, skip if no key found
                    error_count += 1
                    continue
                
                try:
                    # We use update_table_row which usually handles upsert in Genesys
                    # But wait, update_table_row uses put_flows_datatable_row
                    # which replaces the row. If it doesn't exist, it might fail or create.
                    # The SDK documentation says PUT updates. POST creates.
                    # Let's try to check if it exists first? That's slow for bulk.
                    # Let's try update, if fail, try create?
                    # Or just use create_table_row?
                    # Actually, list_tables.update_table_row calls put_flows_datatable_row.
                    # In Genesys Cloud, PUT usually creates if not exists for some resources, but for Data Tables?
                    # "Update a row" -> PUT /api/v2/flows/datatables/{datatableId}/rows/{rowId}
                    # If it doesn't exist, it creates it.
                    
                    list_tables.update_table_row(table_id, row_key, row)
                    success_count += 1
                except Exception:
                    # If update fails, maybe try create?
                    # But PUT should work.
                    error_count += 1
            
            log_audit(session['user_id'], 'RESTORE_TABLE', table_id, f"Restored {success_count} rows. Errors: {error_count}")
            flash(f'Restore completed. Updated/Created: {success_count}, Errors: {error_count}', 'success')
            
        except Exception as e:
            flash(f'Restore failed: {str(e)}', 'error')
            
    return redirect(url_for('view_table', table_id=table_id))

# --- Admin Routes ---

@app.route('/admin')
@login_required
@admin_required
def admin_dashboard():
    # Show all users, including other admins
    users = User.query.all()
    return render_template('admin/dashboard.html', users=users)

@app.route('/admin/audit')
@login_required
@admin_required
def admin_audit_logs():
    logs = AuditLog.query.order_by(AuditLog.timestamp.desc()).all()
    return render_template('admin/audit_logs.html', logs=logs)

@app.route('/admin/audit/rollback/<int:log_id>', methods=['POST'])
@login_required
@admin_required
def rollback_audit(log_id):
    log = AuditLog.query.get_or_404(log_id)
    
    if not log.previous_state:
        flash('Cannot rollback: No previous state recorded.', 'error')
        return redirect(url_for('admin_audit_logs'))
        
    try:
        prev_state = json.loads(log.previous_state)
        
        if log.action == 'UPDATE_ROW':
            # Target format: table_id|row_key
            parts = log.target.split('|')
            if len(parts) >= 2:
                table_id = parts[0]
                row_key = parts[1]
                
                # Ensure we send the correct data types
                # prev_state is a dict, but we need to make sure it matches the schema
                # list_tables.update_table_row expects a dict
                
                # IMPORTANT: When rolling back, we must ensure we are sending the COMPLETE row data
                # as it was before. The prev_state captured in update_row is 'existing_row' which
                # is the full row data from get_table_row.
                
                list_tables.update_table_row(table_id, row_key, prev_state)
                flash('Row rollback successful.', 'success')
                
                # Log the rollback
                log_audit(session['user_id'], 'ROLLBACK', log.target, f"Rolled back log #{log.id}")
            else:
                flash('Invalid target format for rollback.', 'error')

        elif log.action == 'UPDATE_CONFIG':
            config = AppConfig.query.first()
            if config:
                config.client_id = prev_state.get('client_id')
                config.client_secret = prev_state.get('client_secret')
                config.region = prev_state.get('region')
                db.session.commit()
                
                # Update runtime
                list_tables.set_credentials(config.client_id, config.client_secret, config.region)
                list_tables.authenticate()
                
                flash('Configuration rollback successful.', 'success')
                log_audit(session['user_id'], 'ROLLBACK', 'AppConfig', f"Rolled back log #{log.id}")
                
        elif log.action == 'UPDATE_PERMISSION':
            # Target format: table_id|user_email
            parts = log.target.split('|')
            if len(parts) >= 2:
                table_id = parts[0]
                user_email = parts[1]
                user = User.query.filter_by(email=user_email).first()
                
                if user:
                    perm = TablePermission.query.filter_by(user_id=user.id, table_id=table_id).first()
                    if not perm:
                        perm = TablePermission(user_id=user.id, table_id=table_id)
                        db.session.add(perm)
                    
                    perm.can_update_rows = prev_state.get('can_update_rows', False)
                    
                    # Restore columns
                    ColumnPermission.query.filter_by(table_permission_id=perm.id).delete()
                    for col, access in prev_state.get('columns', {}).items():
                        cp = ColumnPermission(table_permission_id=perm.id, column_name=col, access_level=access)
                        db.session.add(cp)
                        
                    db.session.commit()
                    flash('Permission rollback successful.', 'success')
                    log_audit(session['user_id'], 'ROLLBACK', log.target, f"Rolled back log #{log.id}")
                else:
                    flash('User not found for rollback.', 'error')
            else:
                flash('Invalid target format for rollback.', 'error')
                
        else:
            flash(f'Rollback not implemented for action: {log.action}', 'warning')
            
    except Exception as e:
        flash(f'Rollback failed: {str(e)}', 'error')
        
    return redirect(url_for('admin_audit_logs'))

@app.route('/admin/users/create', methods=['POST'])
@login_required
@admin_required
def create_user():
    email = request.form.get('email')
    password = request.form.get('password')
    role = request.form.get('role', 'user')
    
    if not email or not password:
        flash('Email and password are required.', 'error')
        return redirect(url_for('admin_dashboard'))
        
    if User.query.filter_by(email=email).first():
        flash('User already exists.', 'error')
        return redirect(url_for('admin_dashboard'))
        
    try:
        new_user = User(email=email, role=role)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()
        
        log_audit(session['user_id'], 'CREATE_USER', email, f"Created user {email} with role {role}")
        flash('User created successfully.', 'success')
    except Exception as e:
        flash(f'Error creating user: {e}', 'error')
        
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/users/update/<int:user_id>', methods=['POST'])
@login_required
@admin_required
def update_user(user_id):
    user = User.query.get_or_404(user_id)
    
    password = request.form.get('password')
    role = request.form.get('role')
    
    try:
        changes = []
        if password:
            user.set_password(password)
            changes.append("password changed")
            
        if role and role != user.role:
            old_role = user.role
            user.role = role
            changes.append(f"role changed from {old_role} to {role}")
            
        if changes:
            db.session.commit()
            log_audit(session['user_id'], 'UPDATE_USER', user.email, f"Updated user: {', '.join(changes)}")
            flash('User updated successfully.', 'success')
        else:
            flash('No changes made.', 'info')
            
    except Exception as e:
        flash(f'Error updating user: {e}', 'error')
        
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/users/delete/<int:user_id>', methods=['POST'])
@login_required
@admin_required
def delete_user(user_id):
    user = User.query.get_or_404(user_id)
    
    if user.id == session['user_id']:
        flash('You cannot delete yourself.', 'error')
        return redirect(url_for('admin_dashboard'))
        
    try:
        email = user.email
        # Delete related permissions first (cascade should handle it but let's be safe if not set up)
        # SQLAlchemy cascade="all, delete-orphan" is on TablePermission->ColumnPermission
        # But User->TablePermission might need manual cleanup if not set.
        # Model says: table_permissions = db.relationship('TablePermission', backref='user', lazy=True)
        # Default cascade is usually not delete.
        
        TablePermission.query.filter_by(user_id=user.id).delete()
        db.session.delete(user)
        db.session.commit()
        
        log_audit(session['user_id'], 'DELETE_USER', email, f"Deleted user {email}")
        flash('User deleted successfully.', 'success')
    except Exception as e:
        flash(f'Error deleting user: {e}', 'error')
        
    return redirect(url_for('admin_dashboard'))

@app.route('/admin/config', methods=['GET', 'POST'])
@login_required
@admin_required
def admin_config():
    if request.method == 'POST':
        # Create new environment
        name = request.form.get('name')
        client_id = request.form.get('client_id')
        client_secret = request.form.get('client_secret')
        region = request.form.get('region')
        
        if not name or not client_id or not client_secret:
            flash('All fields are required.', 'error')
        else:
            new_config = AppConfig(name=name, client_id=client_id, client_secret=client_secret, region=region, is_active=False)
            db.session.add(new_config)
            db.session.commit()
            
            log_audit(session['user_id'], 'CREATE_CONFIG', 'AppConfig', f"Created environment: {name}")
            flash('Environment created successfully.', 'success')
            
        return redirect(url_for('admin_config'))
        
    configs = AppConfig.query.all()
    return render_template('admin/config.html', configs=configs)

@app.route('/admin/config/activate/<int:config_id>', methods=['POST'])
@login_required
@admin_required
def activate_config(config_id):
    config = AppConfig.query.get_or_404(config_id)
    
    # Deactivate all
    AppConfig.query.update({AppConfig.is_active: False})
    
    # Activate selected
    config.is_active = True
    db.session.commit()
    
    # Update runtime
    list_tables.set_credentials(config.client_id, config.client_secret, config.region)
    list_tables.authenticate()
    
    log_audit(session['user_id'], 'ACTIVATE_CONFIG', 'AppConfig', f"Activated environment: {config.name}")
    flash(f'Environment "{config.name}" activated.', 'success')
    
    return redirect(url_for('admin_config'))

@app.route('/admin/config/delete/<int:config_id>', methods=['POST'])
@login_required
@admin_required
def delete_config(config_id):
    config = AppConfig.query.get_or_404(config_id)
    
    if config.is_active:
        flash('Cannot delete the active environment.', 'error')
        return redirect(url_for('admin_config'))
        
    db.session.delete(config)
    db.session.commit()
    
    log_audit(session['user_id'], 'DELETE_CONFIG', 'AppConfig', f"Deleted environment: {config.name}")
    flash('Environment deleted successfully.', 'success')
    
    return redirect(url_for('admin_config'))

@app.route('/admin/user/<int:user_id>')
@login_required
@admin_required
def admin_user_tables(user_id):
    user = User.query.get_or_404(user_id)
    tables = list_tables.list_data_tables()
    
    # Get permissions for this user
    perms = TablePermission.query.filter_by(user_id=user.id).all()
    # Convert to a dict for easier lookup in template: {table_id: perm_obj}
    user_perms = {p.table_id: p for p in perms}
    
    return render_template('admin/user_tables.html', 
                           user=user, 
                           tables=tables, 
                           user_perms=user_perms)

@app.route('/admin/user/<int:user_id>/table/<table_id>', methods=['GET', 'POST'])
@login_required
@admin_required
def admin_configure_table(user_id, table_id):
    user = User.query.get_or_404(user_id)
    
    # Get or create permission object
    perm = TablePermission.query.filter_by(user_id=user.id, table_id=table_id).first()
    if not perm:
        perm = TablePermission(user_id=user.id, table_id=table_id)
        db.session.add(perm)
        # Don't commit yet, wait for POST or just add to session
    
    if request.method == 'POST':
        # Capture previous state
        prev_state = {
            'can_update_rows': perm.can_update_rows,
            'can_read_rows': perm.can_read_rows,
            'columns': {cp.column_name: cp.access_level for cp in perm.column_permissions}
        }
        
        perm.can_update_rows = request.form.get('can_update') == 'on'
        perm.can_read_rows = request.form.get('can_read') == 'on'
        db.session.add(perm) # Ensure it's in session if it was new
        db.session.commit() # Commit to get ID if it was new
        
        # Update columns
        # First, clear existing column permissions for this table/user? 
        # Or update/insert. Clearing is easier.
        ColumnPermission.query.filter_by(table_permission_id=perm.id).delete()
        
        new_cols = {}
        for key, value in request.form.items():
            if key.startswith('col_'):
                col_name = key[4:]
                cp = ColumnPermission(table_permission_id=perm.id, column_name=col_name, access_level=value)
                db.session.add(cp)
                new_cols[col_name] = value
                
        db.session.commit()
        
        new_state = {
            'can_update_rows': perm.can_update_rows,
            'can_read_rows': perm.can_read_rows,
            'columns': new_cols
        }
        
        log_audit(session['user_id'], 'UPDATE_PERMISSION', f"{table_id}|{user.email}", f"Can Update: {perm.can_update_rows}, Can Read: {perm.can_read_rows}",
                  previous_state=prev_state, new_state=new_state)
        
        flash('Permissions updated successfully.', 'success')
        return redirect(url_for('admin_user_tables', user_id=user.id))

    # GET
    full_schema = list_tables.get_table_schema(table_id)
    schema = full_schema.get('properties', {}) if full_schema else {}
    
    # Prepare table_perms dict for template
    # We need to pass the permission object and its columns
    # Let's construct a dict similar to what the template expects
    table_perms_dict = {
        'can_update_rows': perm.can_update_rows,
        'can_read_rows': perm.can_read_rows,
        'columns': {cp.column_name: cp.access_level for cp in perm.column_permissions} if perm.id else {}
    }
    
    return render_template('admin/configure_table.html', 
                           user=user, 
                           table_id=table_id, 
                           schema=schema, 
                           table_perms=table_perms_dict)

if __name__ == '__main__':
    print("Starting Flask server...")
    app.run(debug=True, use_reloader=True)
