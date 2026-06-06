"""
Rewards Auth Backend — Multi-Tenant Owner Authentication
Deploy to Render (free tier) as a Web Service

Endpoints:
  POST /register  — validate email, send 6-digit code, store pending
  POST /verify    — confirm code, return session token
  POST /setup     — create shop file + store owner credentials
  POST /login     — authenticate owner, return token
  POST /reset     — send password reset email

Build:  pip install flask gunicorn bcrypt
Start:  gunicorn server:app
"""

import os
import re
import json
import time
import uuid
import hmac
import random
import string
import hashlib
import smtplib
import secrets
import base64
import urllib.request
from email.mime.text import MIMEText
from datetime import datetime, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ═══════════════════════
# CONFIG (set via Render environment variables)
# ═══════════════════════

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
FROM_EMAIL = os.environ.get("FROM_EMAIL", SMTP_USER)

# GitHub config for creating shop files in rewards-data repo
# Local dev token — replace with env var for production
# GitHub config for creating shop files in rewards-data repo
GH_TOKEN=os.env...EN", "")
GH_DATA_REPO = "CRYPTORICH/rewards-data"
GH_AUTH_REPO=os.env...O", "CRYPTORICH/rewards-auth")  # PRIVATE repo

# If no SMTP creds, we're in dev mode — log codes instead
DEV_MODE = not (SMTP_USER and SMTP_PASS)

# ═══════════════════════
# IN-MEMORY STORE (Render free tier has no disk persistence)
# For production, swap with SQLite
# ═══════════════════════

pending = {}       # email → {code, shop_name, slug, expires_at}
sessions = {}      # token → {email, slug, expires_at}
owners = {}        # slug → {email, password_hash, created_at}

# ═══════════════════════
# HELPERS
# ═══════════════════════

def _hash_pw(password):
    """bcrypt-like using hashlib (bcrypt is ideal, add pip install bcrypt for production)"""
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
    return salt + ':' + h.hex()

def _check_pw(password, stored):
    """Verify password against stored hash"""
    try:
        salt, h = stored.split(':', 1)
        check = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100000)
        return hmac.compare_digest(check.hex(), h)
    except:
        return False

def _gen_code():
    return ''.join([str(random.randint(0,9)) for _ in range(6)])

def _gen_token():
    return secrets.token_urlsafe(32)

def _valid_email(email):
    return re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email)

def _valid_slug(slug):
    return re.match(r'^[a-z0-9][a-z0-9-]{2,30}$', slug)

def _send_email(to, subject, body):
    """Send via Gmail SMTP. Returns (success, error_message)"""
    if DEV_MODE:
        print(f"[DEV MODE] Would send to {to}: {subject}")
        print(f"  Body: {body[:200]}")
        return True, None

    try:
        msg = MIMEText(body)
        msg['Subject'] = subject
        msg['From'] = FROM_EMAIL
        msg['To'] = to

        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(FROM_EMAIL, [to], msg.as_string())
        server.quit()
        return True, None
    except Exception as e:
        return False, str(e)

def _github_api(method, repo, path, body=None, token=None):
    """Call GitHub REST API"""
    tok = token or GH_TOKEN
    if not tok:
        raise Exception("GitHub token not configured")

    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    req = urllib.request.Request(url, method=method)
    req.add_header('Authorization', f'Bearer {tok}')
    req.add_header('Accept', 'application/vnd.github.v3+json')
    req.add_header('User-Agent', 'RewardsAuth/1.0')

    if body:
        data = json.dumps(body).encode()
        req.add_header('Content-Type', 'application/json')
        req.data = data

    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read()), resp.status
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        try:
            return json.loads(err_body), e.code
        except:
            return {"error": err_body}, e.code

def _create_shop_file(slug, shop_data):
    """Create shops/{slug}.json in the rewards-data repo"""
    content = json.dumps(shop_data, indent=2)
    encoded = base64.b64encode(content.encode()).decode()
    body = {
        "message": f"Create shop: {slug}",
        "content": encoded,
        "branch": "main"
    }
    return _github_api('PUT', GH_DATA_REPO, f"shops/{slug}.json", body)

def _store_owner(slug, owner_data):
    """Store owner credentials in the PRIVATE rewards-auth repo.
    Since we can't reliably read/modify a single JSON file without race conditions
    across Render instances, we'll use the GitHub API to create a file per owner.
    """
    content = json.dumps(owner_data, indent=2)
    encoded = base64.b64encode(content.encode()).decode()

    # Try to create the file (will fail if exists — owner already registered)
    body = {
        "message": f"Register owner: {slug}",
        "content": encoded,
        "branch": "main"
    }
    return _github_api('PUT', GH_AUTH_REPO, f"owners/{slug}.json", body)

def _get_owner(slug):
    """Fetch owner credentials from private auth repo"""
    try:
        result, status = _github_api('GET', GH_AUTH_REPO, f"owners/{slug}.json")
        if status == 200 and 'content' in result:
            decoded = base64.b64decode(result['content']).decode()
            return json.loads(decoded)
    except:
        pass
    return None

def _cleanup_expired():
    """Remove expired pending registrations and sessions"""
    now = datetime.now()
    for email in list(pending.keys()):
        if pending[email].get('expires_at', now) < now:
            del pending[email]
    for token in list(sessions.keys()):
        if sessions[token].get('expires_at', now) < now:
            del sessions[token]

# ═══════════════════════
# ROUTES
# ═══════════════════════

@app.route('/register', methods=['POST'])
def register():
    """Step 1: Validate email + shop name, send verification code"""
    data = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    shop_name = (data.get('shop_name') or '').strip()
    slug = (data.get('slug') or '').strip().lower()

    if not _valid_email(email):
        return jsonify({"error": "Invalid email address"}), 400
    if not shop_name or len(shop_name) < 2:
        return jsonify({"error": "Shop name must be at least 2 characters"}), 400
    if not _valid_slug(slug):
        return jsonify({"error": "Slug must be 3-30 lowercase letters/numbers/hyphens"}), 400

    # Check if slug already taken (check both data file and auth)
    existing_owner = _get_owner(slug)
    if existing_owner:
        return jsonify({"error": "This shop URL is already taken. Try a different slug."}), 409

    # Check if data file already exists
    try:
        result, status = _github_api('GET', GH_DATA_REPO, f"shops/{slug}.json")
        if status == 200:
            return jsonify({"error": "This shop URL is already taken."}), 409
    except:
        pass

    _cleanup_expired()

    # Rate limit: max 3 verification attempts per email per hour
    if email in pending and pending[email].get('attempts', 0) >= 3:
        return jsonify({"error": "Too many attempts. Please wait an hour."}), 429

    code = _gen_code()
    expires = datetime.now() + timedelta(minutes=15)

    pending[email] = {
        "code": code,
        "shop_name": shop_name,
        "slug": slug,
        "expires_at": expires,
        "attempts": pending.get(email, {}).get('attempts', 0) + 1,
        "created_at": datetime.now().isoformat()
    }

    # Send verification email
    subject = f"Your Rewards Verification Code: {code}"
    body = f"""Welcome to Rewards!

Your verification code is: {code}

Shop: {shop_name}
URL slug: {slug}

This code expires in 15 minutes.

If you didn't request this, ignore this email.

— The Rewards Team
"""
    success, err = _send_email(email, subject, body)

    if not success and not DEV_MODE:
        # Clean up pending if email failed
        del pending[email]
        return jsonify({"error": f"Failed to send email: {err}"}), 500

    log_msg = f"[DEV] Code for {email}: {code}" if DEV_MODE else f"Verification code sent to {email}"
    print(log_msg)

    return jsonify({
        "message": "Verification code sent",
        "dev_code": code if DEV_MODE else None,
        "expires_in": 900
    })

@app.route('/verify', methods=['POST'])
def verify():
    """Step 2: Confirm verification code, return session token"""
    data = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    code = (data.get('code') or '').strip()

    if not email or not code:
        return jsonify({"error": "Email and code required"}), 400

    _cleanup_expired()

    entry = pending.get(email)
    if not entry:
        return jsonify({"error": "No pending verification for this email. Request a new code."}), 404

    if datetime.now() > entry.get('expires_at', datetime.now()):
        del pending[email]
        return jsonify({"error": "Code expired. Request a new one."}), 410

    if code != entry['code']:
        return jsonify({"error": "Wrong code. Try again."}), 401

    # Create session
    token = _gen_token()
    sessions[token] = {
        "email": email,
        "slug": entry['slug'],
        "shop_name": entry['shop_name'],
        "expires_at": datetime.now() + timedelta(hours=1)
    }

    # Don't delete pending yet — still need it for setup step
    # (Will be cleaned up after setup completes)

    return jsonify({
        "message": "Email verified",
        "token": token
    })

@app.route('/setup', methods=['POST'])
def setup():
    """Step 3: Set password + PIN, create shop"""
    auth = request.headers.get('Authorization', '')
    token = auth.replace('Bearer ', '')

    if not token or token not in sessions:
        return jsonify({"error": "Invalid or expired session. Start over."}), 401

    session = sessions[token]
    slug = session['slug']
    shop_name = session['shop_name']
    email = session['email']

    data = request.get_json() or {}
    password = data.get('password', '')
    pin = data.get('pin', '0000')
    accent_color = data.get('accent_color', '#059669')

    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400
    if len(pin) < 4 or not pin.isdigit():
        return jsonify({"error": "PIN must be at least 4 digits"}), 400

    # Hash password and PIN
    pw_hash = _hash_pw(password)
    pin_hash = _hash_pw(pin)  # We'll store PIN hash separately for staff panel

    # Create the shop data file in rewards-data
    shop_data = {
        "customers": {},
        "config": {
            "shop_name": shop_name,
            "accent_color": accent_color,
            "birthday_bonus": 50,
            "referral_bonus": 100,
            "double_points_days": [],
            "staff_pin": pin,
            "daily_goal": 10,
            "version": 1,
            "created_at": datetime.now().isoformat(),
            "owner_email": email
        }
    }

    try:
        result, status = _create_shop_file(slug, shop_data)
        if status not in [200, 201]:
            return jsonify({"error": f"Failed to create shop: {result.get('message', 'Unknown error')}"}), 500
    except Exception as e:
        return jsonify({"error": f"Failed to create shop data: {str(e)}"}), 500

    # Store owner credentials in PRIVATE auth repo
    owner_data = {
        "email": email,
        "slug": slug,
        "shop_name": shop_name,
        "password_hash": pw_hash,
        "pin_hash": pin_hash,
        "accent_color": accent_color,
        "created_at": datetime.now().isoformat(),
        "plan": "trial",
        "trial_ends": (datetime.now() + timedelta(days=14)).isoformat()
    }

    try:
        result, status = _store_owner(slug, owner_data)
        if status not in [200, 201]:
            # Shop data was created but owner storage failed — log but don't fail
            print(f"WARNING: Shop {slug} created but owner storage failed: {result}")
    except Exception as e:
        print(f"WARNING: Owner storage failed for {slug}: {e}")

    # Clean up pending registration
    if email in pending:
        del pending[email]

    # Keep session alive for redirect
    sessions[token]['expires_at'] = datetime.now() + timedelta(hours=24)

    return jsonify({
        "message": "Shop created successfully",
        "slug": slug,
        "staff_url": f"staff.html?shop={slug}",
        "customer_url": f"customer.html?shop={slug}"
    })

@app.route('/login', methods=['POST'])
def login():
    """Authenticate owner, return session token"""
    data = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password', '')

    if not email or not password:
        return jsonify({"error": "Email and password required"}), 400

    # Find owner by email — iterate through known owners
    # In production, maintain an email→slug index
    owner = None
    owner_slug = None
    for slug in owners:
        if owners[slug].get('email') == email:
            owner = owners[slug]
            owner_slug = slug
            break

    # Also try to load from auth repo
    if not owner:
        # We need to find the slug from email — for now, try common slugs
        # In production, maintain an email index file
        pass

    if not owner:
        return jsonify({"error": "Account not found"}), 404

    if not _check_pw(password, owner.get('password_hash', '')):
        return jsonify({"error": "Wrong password"}), 401

    token = _gen_token()
    sessions[token] = {
        "email": email,
        "slug": owner_slug,
        "expires_at": datetime.now() + timedelta(hours=24)
    }

    return jsonify({
        "message": "Logged in",
        "token": token,
        "slug": owner_slug
    })

@app.route('/reset', methods=['POST'])
def reset():
    """Send password reset email"""
    data = request.get_json() or {}
    email = (data.get('email') or '').strip().lower()

    if not _valid_email(email):
        return jsonify({"error": "Invalid email"}), 400

    # Always return success to prevent email enumeration
    msg = "If that email is registered, a reset link has been sent."

    # Find owner and send reset
    for slug in owners:
        if owners[slug].get('email') == email:
            token = _gen_token()
            sessions[f"reset_{token}"] = {
                "email": email,
                "slug": slug,
                "expires_at": datetime.now() + timedelta(minutes=30)
            }

            reset_url = f"admin.html?reset={token}"
            _send_email(email, "Reset Your Rewards Password",
                f"Click this link to reset your password:\n\n{reset_url}\n\nThis link expires in 30 minutes.")
            break

    return jsonify({"message": msg})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "dev_mode": DEV_MODE,
        "pending": len(pending),
        "sessions": len(sessions),
        "time": datetime.now().isoformat()
    })

# ═══════════════════════
# PERIODIC CLEANUP
# ═══════════════════════

@app.before_request
def before_request():
    # Clean up expired entries (cheap, runs each request)
    if random.random() < 0.1:  # ~10% of requests
        _cleanup_expired()

# ═══════════════════════
# RUN
# ═══════════════════════

if __name__ == '__main__':
    print(f"Starting Rewards Auth Backend...")
    print(f"DEV_MODE: {DEV_MODE}")
    print(f"Endpoints: /register /verify /setup /login /reset /health")
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=True)
