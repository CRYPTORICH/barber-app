"""
Smoke Shop Rewards API v2 — Dispensary-Grade Loyalty Engine
Tier system, birthday rewards, referrals, visit streaks, amplified redemption.
Deploy on Render free tier with GitHub JSON persistence.
"""
import json
import os
import uuid
import random
import string
from datetime import datetime, timezone, timedelta
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "shop_data.json"

GITHUB_REPO = "CRYPTORICH/rewards-data"
GITHUB_PATH = "shop_data.json"
GITHUB_API = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{GITHUB_PATH}"
GITHUB_TOKEN = None

def _load_token():
    global GITHUB_TOKEN
    from helper import rev, getenv
    token_file = BASE_DIR / ".ghtoken"
    if token_file.exists():
        with open(token_file) as f:
            raw = f.read().strip()
        GITHUB_TOKEN = rev(raw)
        GITHUB_TOKEN = getenv()

# ═══════════════════════════════════════════
# TIER SYSTEM
# ═══════════════════════════════════════════

TIERS = [
    {"name": "Bronze", "min_points": 0,      "earn_bonus": 0.0,  "redeem_rate": 1.0,  "color": "#cd7f32", "icon": "🥉"},
    {"name": "Silver", "min_points": 500,    "earn_bonus": 0.10, "redeem_rate": 1.25, "color": "#a8a8a8", "icon": "🥈"},
    {"name": "Gold",   "min_points": 2000,   "earn_bonus": 0.25, "redeem_rate": 1.50, "color": "#d4a843", "icon": "🥇"},
    {"name": "Platinum","min_points": 5000,  "earn_bonus": 0.50, "redeem_rate": 2.00, "color": "#e5e5e5", "icon": "💎"},
]

def get_tier(customer):
    """Determine tier from lifetime points."""
    pts = customer.get("lifetime_points", 0)
    tier = TIERS[0]
    for t in TIERS:
        if pts >= t["min_points"]:
            tier = t
    return tier

def next_tier(customer):
    """What's the next tier and how far away?"""
    pts = customer.get("lifetime_points", 0)
    for t in TIERS:
        if pts < t["min_points"]:
            return {"name": t["name"], "icon": t["icon"], "needed": t["min_points"] - pts}
    return None  # Already at max tier

def calc_points(amount, tier):
    """Calculate points from purchase, including tier earn bonus."""
    base = int(amount) * 10  # 10 pts per whole dollar
    bonus = int(base * tier["earn_bonus"])
    return base + bonus

def calc_redemption(points, tier):
    """Calculate dollar value when redeeming points. Tier amplifies value."""
    return round((points / 100) * tier["redeem_rate"], 2)

VISIT_BONUSES = {2: 25, 3: 50, 4: 75}  # 3rd visit = 50 bonus, 4th+ = 75

# ═══════════════════════════════════════════
# GITHUB PERSISTENCE
# ═══════════════════════════════════════════

def _github_fetch():
    if not GITHUB_TOKEN:
        return _local_fetch()
    try:
        r = requests.get(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, timeout=10)
        if r.status_code == 200:
            import base64
            return json.loads(base64.b64decode(r.json()["content"]).decode())
        elif r.status_code == 404:
            return _default_data()
    except Exception:
        pass
    return _local_fetch()

def _local_fetch():
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f)
    return _default_data()

def _default_data():
    return {"customers": {}, "config": {
        "shop_name": "Smoke Shop Rewards", "points_per_dollar": 10,
        "points_value_cents": 1, "birthday_bonus": 50,
        "referral_bonus": 100, "double_points_days": []
    }}

def _github_push(data):
    if not GITHUB_TOKEN:
        _local_save(data)
        return
    try:
        import base64
        content = base64.b64encode(json.dumps(data, indent=2).encode()).decode()
        r = requests.get(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, timeout=10)
        sha = r.json().get("sha") if r.status_code == 200 else None
        payload = {"message": "Update shop data", "content": content, "branch": "main"}
        if sha:
            payload["sha"] = sha
        requests.put(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, json=payload, timeout=10)
    except Exception:
        _local_save(data)

def _local_save(data):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)

# ═══════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════

def _clean_phone(raw):
    return "".join(c for c in (raw or "").strip() if c.isdigit())

def _generate_code(length=8):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))

def _enrich_customer(c):
    """Add computed tier info to customer object."""
    tier = get_tier(c)
    nxt = next_tier(c)
    c["tier"] = tier
    c["next_tier"] = nxt
    c["points_value"] = calc_redemption(c.get("points", 0), tier)
    return c

# ═══════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════

@app.route("/health")
def health():
    return jsonify({"ok": True, "time": datetime.now(timezone.utc).isoformat()})

# ── Customer CRUD ──

@app.route("/api/customer", methods=["POST"])
def find_or_create():
    body = request.get_json() or {}
    phone = _clean_phone(body.get("phone", ""))
    if not phone:
        return jsonify({"error": "Phone number required"}), 400

    data = _github_fetch()
    customers = data.get("customers", {})

    if phone in customers:
        return jsonify({"found": True, "customer": _enrich_customer(customers[phone])})

    # New customer
    c = {
        "id": str(uuid.uuid4())[:8],
        "phone": phone,
        "name": body.get("name", ""),
        "points": 0,
        "lifetime_points": 0,
        "lifetime_spend": 0,
        "visit_count": 0,
        "birthday": body.get("birthday", ""),
        "referral_code": _generate_code(),
        "referred_by": body.get("referred_by", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "transactions": []
    }

    # Referral bonus — if referred, credit referrer
    if c["referred_by"]:
        for _, ref in customers.items():
            if ref.get("referral_code") == c["referred_by"]:
                bonus = data["config"].get("referral_bonus", 100)
                ref["points"] = ref.get("points", 0) + bonus
                ref.setdefault("transactions", []).append({
                    "id": str(uuid.uuid4())[:8], "type": "referral_bonus",
                    "points": bonus,
                    "note": f"Referred {phone}",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                c["points"] = bonus  # New customer also gets bonus
                c.setdefault("transactions", []).append({
                    "id": str(uuid.uuid4())[:8], "type": "referral_bonus",
                    "points": bonus,
                    "note": f"Signed up via {c['referred_by']}",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                break

    customers[phone] = c
    data["customers"] = customers
    _github_push(data)
    return jsonify({"found": False, "customer": _enrich_customer(c)}), 201

@app.route("/api/customer/<phone>")
def get_customer(phone):
    phone = _clean_phone(phone)
    data = _github_fetch()
    c = data.get("customers", {}).get(phone)
    if not c:
        return jsonify({"error": "Customer not found"}), 404
    return jsonify({"customer": _enrich_customer(c)})

# ── Purchase ──

@app.route("/api/purchase", methods=["POST"])
def add_purchase():
    body = request.get_json() or {}
    phone = _clean_phone(body.get("phone", ""))
    amount = float(body.get("amount", 0))

    if not phone:
        return jsonify({"error": "Phone required"}), 400
    if amount <= 0:
        return jsonify({"error": "Amount must be positive"}), 400

    data = _github_fetch()
    customers = data.get("customers", {})
    config = data.get("config", {})

    if phone not in customers:
        return jsonify({"error": "Customer not found", "phone": phone}), 404

    c = customers[phone]
    tier = get_tier(c)

    # Double points days?
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    multiplier = 2 if today in config.get("double_points_days", []) else 1

    points_earned = calc_points(amount, tier) * multiplier
    c["points"] = c.get("points", 0) + points_earned
    c["lifetime_points"] = c.get("lifetime_points", 0) + points_earned
    c["lifetime_spend"] = round(c.get("lifetime_spend", 0) + amount, 2)
    c["visit_count"] = c.get("visit_count", 0) + 1

    # Check if tier changed after this purchase
    new_tier = get_tier(c)
    tier_up = new_tier["name"] != tier["name"]

    # Visit streak bonus
    visit_bonus = VISIT_BONUSES.get(c["visit_count"], 0)
    if visit_bonus > 0:
        c["points"] += visit_bonus
        points_earned += visit_bonus

    # Birthday month bonus (first visit in birthday month)
    if c.get("birthday"):
        try:
            bday = datetime.strptime(c["birthday"], "%Y-%m-%d") if "-" in c["birthday"] else datetime.strptime(c["birthday"], "%m-%d")
            if bday.month == datetime.now(timezone.utc).month:
                # Only once per birthday month
                already_got = any(
                    t.get("type") == "birthday_bonus" and 
                    datetime.fromisoformat(t["timestamp"]).year == datetime.now(timezone.utc).year
                    for t in c.get("transactions", [])
                )
                if not already_got:
                    bonus = config.get("birthday_bonus", 50)
                    c["points"] += bonus
                    points_earned += bonus
                    c.setdefault("transactions", []).append({
                        "id": str(uuid.uuid4())[:8], "type": "birthday_bonus",
                        "points": bonus,
                        "note": f"🎂 Birthday month bonus ({new_tier['name']} tier)",
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    })
        except ValueError:
            pass

    txn = {
        "id": str(uuid.uuid4())[:8], "type": "purchase",
        "amount": round(amount, 2), "points": points_earned,
        "tier": new_tier["name"], "multiplier": multiplier,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    c.setdefault("transactions", []).append(txn)

    if visit_bonus:
        c["transactions"].append({
            "id": str(uuid.uuid4())[:8], "type": "visit_bonus",
            "points": visit_bonus,
            "note": f"Visit #{c['visit_count']} streak bonus",
            "timestamp": datetime.now(timezone.utc).isoformat()
        })

    customers[phone] = c
    data["customers"] = customers
    _github_push(data)

    return jsonify({
        "customer": _enrich_customer(c), "transaction": txn,
        "points_earned": points_earned, "tier_up": tier_up,
        "new_tier": new_tier["name"] if tier_up else None
    })

# ── Redeem ──

@app.route("/api/redeem", methods=["POST"])
def redeem_points():
    body = request.get_json() or {}
    phone = _clean_phone(body.get("phone", ""))
    points_to_redeem = int(body.get("points", 0))

    if not phone:
        return jsonify({"error": "Phone required"}), 400
    if points_to_redeem <= 0:
        return jsonify({"error": "Points must be positive"}), 400

    data = _github_fetch()
    customers = data.get("customers", {})

    if phone not in customers:
        return jsonify({"error": "Customer not found"}), 404

    c = customers[phone]
    if c.get("points", 0) < points_to_redeem:
        return jsonify({"error": "Insufficient points", "available": c["points"]}), 400

    tier = get_tier(c)
    value = calc_redemption(points_to_redeem, tier)
    c["points"] -= points_to_redeem

    txn = {
        "id": str(uuid.uuid4())[:8], "type": "redeem",
        "points": -points_to_redeem, "value": value,
        "tier": tier["name"],
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    c.setdefault("transactions", []).append(txn)
    customers[phone] = c
    data["customers"] = customers
    _github_push(data)

    return jsonify({
        "customer": _enrich_customer(c), "transaction": txn, "value": value
    })

# ── Stats ──

@app.route("/api/stats")
def get_stats():
    data = _github_fetch()
    customers = data.get("customers", {})
    custs = list(customers.values())
    config = data.get("config", {})

    tier_counts = {}
    for c in custs:
        t = get_tier(c)["name"]
        tier_counts[t] = tier_counts.get(t, 0) + 1

    total_pts = sum(c.get("points", 0) for c in custs)
    tier = TIERS[0]  # default for value calc
    outstanding_value = calc_redemption(total_pts, {"redeem_rate": 1.0})

    # Birthday month customers
    now = datetime.now(timezone.utc)
    birthdays = sum(1 for c in custs if c.get("birthday") and 
        (lambda b: b.month == now.month if (b := _parse_bday(c["birthday"])) else False)(None))

    return jsonify({
        "total_customers": len(custs),
        "points_outstanding": total_pts,
        "outstanding_value": outstanding_value,
        "lifetime_points": sum(c.get("lifetime_points", 0) for c in custs),
        "tier_breakdown": tier_counts,
        "birthday_this_month": birthdays,
        "total_referrals": sum(1 for c in custs if c.get("referred_by"))
    })

def _parse_bday(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d") if "-" in s else datetime.strptime(f"2000-{s}", "%Y-%m-%d")
    except ValueError:
        return None

# ── Config ──

@app.route("/api/config", methods=["GET", "POST"])
def manage_config():
    data = _github_fetch()
    if request.method == "POST":
        body = request.get_json() or {}
        config = data.get("config", {})
        for key in ["shop_name", "points_per_dollar", "points_value_cents", 
                     "birthday_bonus", "referral_bonus"]:
            if key in body:
                config[key] = body[key]
        if "double_points_days" in body:
            config["double_points_days"] = body["double_points_days"]
        data["config"] = config
        _github_push(data)
        return jsonify({"config": config})
    return jsonify({"config": data.get("config", {})})

# ── Referral lookup ──

@app.route("/api/referral/<code>")
def lookup_referral(code):
    data = _github_fetch()
    for c in data.get("customers", {}).values():
        if c.get("referral_code") == code.upper():
            return jsonify({"valid": True, "referrer": c.get("name", c["phone"])})
    return jsonify({"valid": False}), 404

if __name__ == "__main__":
    _load_token()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
