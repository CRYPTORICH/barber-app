"""
Rewards Auth Backend
"""

import os
import re
import json
import time
import hmac
import random
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

# Config
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
FROM_EMAIL = os.environ.get("FROM_EMAIL", SMTP_USER)

GH_TOKEN = os.environ.get("GH_TOKEN", "")
GH_DATA_REPO = "CRYPTORICH/rewards-data"
GH_AUTH_REPO = os.environ.get("GH_AUTH_REPO", "CRYPTORICH/rewards-auth")

DEV_MODE = not (SMTP_USER and SMTP_PASS)

# In-memory store
pending = {}
sessions = {}
owners = {}

def _hash_pw(password):
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return salt + ":" + h.hex()

def _check_pw(password, stored):
    try:
        salt, h = stored.split(":", 1)
        check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
        return hmac.compare_digest(check.hex(), h)
    except:
        return False

def _gen_code():
    return "".join([str(random.randint(0,9)) for _ in range(6)])

def _gen_token():
    return secrets.token_urlsafe(32)

def _valid_email(email):
    return re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email)

def _valid_slug(slug):
    return re.match(r"^[a-z0-9][a-z0-9-]{2,30}$", slug)

def _send_email(to, subject, body):
    if DEV_MODE:
        print(f"[DEV] Would send to {to}: {subject}")
        return True, None
    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"] = FROM_EMAIL
        msg["To"] = to
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
        server.starttls()
        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(FROM_EMAIL, [to], msg.as_string())
        server.quit()
        return True, None
    except Exception as e:
        return False, str(e)

def _github_api(method, repo, path, body=None, token=None):
    tok = token or GH_TOKEN
    if not tok:
        raise Exception("GH_TOKEN not configured")
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {tok}")
    req.add_header("Accept", "application/vnd.github.v3+json")
    req.add_header("User-Agent", "RewardsAuth/1.0")
    if body:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
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
    content = json.dumps(shop_data, indent=2)
    encoded = base64.b64encode(content.encode()).decode()
    body = {"message": f"Create shop: {slug}", "content": encoded, "branch": "main"}
    return _github_api("PUT", GH_DATA_REPO, f"shops/{slug}.json", body)

def _store_owner(slug, owner_data):
    content = json.dumps(owner_data, indent=2)
    encoded = base64.b64encode(content.encode()).decode()
    body = {"message": f"Register owner: {slug}", "content": encoded, "branch": "main"}
    return _github_api("PUT", GH_AUTH_REPO, f"owners/{slug}.json", body)

def _get_owner(slug):
    try:
        result, status = _github_api("GET", GH_AUTH_REPO, f"owners/{slug}.json")
        if status == 200 and "content" in result:
            decoded = base64.b64decode(result["content"]).decode()
            return json.loads(decoded)
    except:
        pass
    return None

def _cleanup_expired():
    now = datetime.now()
    for email in list(pending.keys()):
        if pending[email].get("expires_at", now) < now:
            del pending[email]
    for token in list(sessions.keys()):
        if sessions[token].get("expires_at", now) < now:
            del sessions[token]


@app.route("/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    shop_name = (data.get("shop_name") or "").strip()
    slug = (data.get("slug") or "").strip().lower()

    if not _valid_email(email):
        return jsonify({"error": "Invalid email"}), 400
    if not shop_name or len(shop_name) < 2:
        return jsonify({"error": "Shop name too short"}), 400
    if not _valid_slug(slug):
        return jsonify({"error": "Invalid slug"}), 400

    existing = _get_owner(slug)
    if existing:
        return jsonify({"error": "Shop URL taken"}), 409

    try:
        result, status = _github_api("GET", GH_DATA_REPO, f"shops/{slug}.json")
        if status == 200:
            return jsonify({"error": "Shop URL taken"}), 409
    except:
        pass

    _cleanup_expired()

    if email in pending and pending[email].get("attempts", 0) >= 3:
        return jsonify({"error": "Too many attempts"}), 429

    code = _gen_code()
    pending[email] = {
        "code": code,
        "shop_name": shop_name,
        "slug": slug,
        "expires_at": datetime.now() + timedelta(minutes=15),
        "attempts": pending.get(email, {}).get("attempts", 0) + 1
    }

    _send_email(email, f"Rewards Code: {code}", f"Code: {code}\nShop: {shop_name}")

    return jsonify({
        "message": "Code sent",
        "dev_code": code if DEV_MODE else None
    })

@app.route("/verify", methods=["POST"])
def verify():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    code = (data.get("code") or "").strip()

    _cleanup_expired()
    entry = pending.get(email)
    if not entry:
        return jsonify({"error": "No pending verification"}), 404
    if datetime.now() > entry["expires_at"]:
        del pending[email]
        return jsonify({"error": "Code expired"}), 410
    if code != entry["code"]:
        return jsonify({"error": "Wrong code"}), 401

    token = _gen_token()
    sessions[token] = {
        "email": email,
        "slug": entry["slug"],
        "shop_name": entry["shop_name"],
        "expires_at": datetime.now() + timedelta(hours=1)
    }
    return jsonify({"message": "Verified", "token": token})

@app.route("/setup", methods=["POST"])
def setup():
    auth = request.headers.get("Authorization", "")
    token = auth.replace("Bearer ", "")
    if not token or token not in sessions:
        return jsonify({"error": "Invalid session"}), 401

    s = sessions[token]
    data = request.get_json() or {}
    password = data.get("password", "")
    pin = data.get("pin", "0000")
    accent = data.get("accent_color", "#059669")

    if len(password) < 8:
        return jsonify({"error": "Password too short"}), 400
    if len(pin) < 4 or not pin.isdigit():
        return jsonify({"error": "PIN must be 4 digits"}), 400

    pw_hash = _hash_pw(password)

    shop_data = {
        "customers": {},
        "config": {
            "shop_name": s["shop_name"],
            "accent_color": accent,
            "birthday_bonus": 50,
            "referral_bonus": 100,
            "double_points_days": [],
            "staff_pin": pin,
            "daily_goal": 10,
            "version": 1,
            "created_at": datetime.now().isoformat()
        }
    }

    try:
        result, status = _create_shop_file(s["slug"], shop_data)
        if status not in [200, 201]:
            return jsonify({"error": f"Failed: {result.get('message', 'Unknown')}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    owner_data = {
        "email": s["email"],
        "slug": s["slug"],
        "shop_name": s["shop_name"],
        "password_hash": pw_hash,
        "accent_color": accent,
        "created_at": datetime.now().isoformat(),
        "plan": "trial",
        "trial_ends": (datetime.now() + timedelta(days=14)).isoformat()
    }

    try:
        _store_owner(s["slug"], owner_data)
    except Exception as e:
        print(f"WARNING: owner storage failed: {e}")

    if s["email"] in pending:
        del pending[s["email"]]

    return jsonify({
        "message": "Shop created",
        "slug": s["slug"],
        "staff_url": f"staff.html?shop={s['slug']}",
        "customer_url": f"customer.html?shop={s['slug']}"
    })

@app.route("/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password", "")
    for slug in owners:
        if owners[slug].get("email") == email:
            if _check_pw(password, owners[slug]["password_hash"]):
                token = _gen_token()
                sessions[token] = {"email": email, "slug": slug, "expires_at": datetime.now() + timedelta(hours=24)}
                return jsonify({"token": token, "slug": slug})
            return jsonify({"error": "Wrong password"}), 401
    return jsonify({"error": "Not found"}), 404

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "dev_mode": DEV_MODE})

@app.before_request
def before_request():
    if random.random() < 0.1:
        _cleanup_expired()

if __name__ == "__main__":
    print(f"Rewards Auth. DEV_MODE={DEV_MODE}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
