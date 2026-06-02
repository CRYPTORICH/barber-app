"""
Smoke Shop Rewards API
Points-based loyalty program for smoke shops.
Phone lookup, purchase tracking, point redemption.
Deploy on Render free tier with GitHub JSON persistence.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "shop_data.json"

# ── GitHub persistence config ──
GITHUB_REPO = "CRYPTORICH/rewards-data"
GITHUB_PATH = "shop_data.json"
GITHUB_API = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{GITHUB_PATH}"
GITHUB_TOKEN = None

def _load_token():
    """Load and decode GitHub token from reversed .ghtoken."""
    global GITHUB_TOKEN
    token_file = BASE_DIR / ".ghtoken"
    if token_file.exists():
        with open(token_file) as f:
            raw = f.read().strip()
        GITHUB_TOKEN = raw[::-1]  # reverse to decode
    else:
        GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

def _github_fetch():
    """Fetch shop data from GitHub. Falls back to local JSON."""
    if not GITHUB_TOKEN:
        return _local_fetch()
    try:
        r = requests.get(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, timeout=10)
        if r.status_code == 200:
            content = r.json().get("content", "")
            import base64
            decoded = base64.b64decode(content).decode()
            return json.loads(decoded)
        elif r.status_code == 404:
            return {"customers": {}, "config": {
                "points_per_dollar": 10,
                "points_value_cents": 1,
                "shop_name": "Smoke Shop Rewards"
            }}
    except Exception:
        pass
    return _local_fetch()

def _local_fetch():
    """Fallback: load from local JSON file."""
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f)
    return {"customers": {}, "config": {
        "points_per_dollar": 10,
        "points_value_cents": 1,
        "shop_name": "Smoke Shop Rewards"
    }}

def _github_push(data):
    """Push shop data to GitHub."""
    if not GITHUB_TOKEN:
        _local_save(data)
        return
    try:
        import base64
        content = base64.b64encode(
            json.dumps(data, indent=2).encode()
        ).decode()
        # Check if file exists (get SHA)
        r = requests.get(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, timeout=10)
        sha = r.json().get("sha") if r.status_code == 200 else None

        payload = {
            "message": "Update shop data",
            "content": content,
            "branch": "main"
        }
        if sha:
            payload["sha"] = sha

        requests.put(GITHUB_API, headers={
            "Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github.v3+json"
        }, json=payload, timeout=10)
    except Exception:
        _local_save(data)

def _local_save(data):
    """Fallback: save to local JSON file."""
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2, default=str)


# ── Points math ──

ROUND_DOWN = True  # round purchase down to whole dollars

def calc_points(purchase_amount, config):
    dollars = int(purchase_amount) if ROUND_DOWN else purchase_amount
    ppd = config.get("points_per_dollar", 10)
    return dollars * ppd

def calc_redemption_value(points, config):
    pvc = config.get("points_value_cents", 1)
    return round((points * pvc) / 100, 2)


# ── API Routes ──

@app.route("/health")
def health():
    return jsonify({"ok": True, "time": datetime.now(timezone.utc).isoformat()})

@app.route("/api/customer", methods=["POST"])
def find_or_create_customer():
    """Look up customer by phone, or create new."""
    body = request.get_json() or {}
    raw_phone = (body.get("phone") or "").strip()
    phone = "".join(c for c in raw_phone if c.isdigit())
    if not phone:
        return jsonify({"error": "Phone number required"}), 400

    data = _github_fetch()
    customers = data.get("customers", {})

    if phone in customers:
        return jsonify({"found": True, "customer": customers[phone]})

    customer = {
        "id": str(uuid.uuid4())[:8],
        "phone": phone,
        "name": body.get("name", ""),
        "points": 0,
        "lifetime_points": 0,
        "lifetime_spend": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "transactions": []
    }
    customers[phone] = customer
    data["customers"] = customers
    _github_push(data)
    return jsonify({"found": False, "customer": customer}), 201

@app.route("/api/customer/<phone>")
def get_customer(phone):
    """Get customer details by phone."""
    phone = "".join(c for c in phone if c.isdigit())
    data = _github_fetch()
    customer = data.get("customers", {}).get(phone)
    if not customer:
        return jsonify({"error": "Customer not found"}), 404
    return jsonify({"customer": customer})

@app.route("/api/purchase", methods=["POST"])
def add_purchase():
    """Record a purchase and add points."""
    body = request.get_json() or {}
    raw_phone = (body.get("phone") or "").strip()
    phone = "".join(c for c in raw_phone if c.isdigit())
    amount = float(body.get("amount", 0))

    if not phone:
        return jsonify({"error": "Phone required"}), 400
    if amount <= 0:
        return jsonify({"error": "Amount must be positive"}), 400

    data = _github_fetch()
    config = data.get("config", {})
    customers = data.get("customers", {})

    if phone not in customers:
        return jsonify({
            "error": "Customer not found. Create customer first.",
            "phone": phone
        }), 404

    customer = customers[phone]
    points_earned = calc_points(amount, config)

    customer["points"] = customer.get("points", 0) + points_earned
    customer["lifetime_points"] = customer.get("lifetime_points", 0) + points_earned
    customer["lifetime_spend"] = round(
        customer.get("lifetime_spend", 0) + amount, 2
    )

    txn = {
        "id": str(uuid.uuid4())[:8],
        "type": "purchase",
        "amount": round(amount, 2),
        "points": points_earned,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if "transactions" not in customer:
        customer["transactions"] = []
    customer["transactions"].append(txn)
    customers[phone] = customer
    data["customers"] = customers
    _github_push(data)

    return jsonify({
        "customer": customer,
        "transaction": txn,
        "points_earned": points_earned
    })

@app.route("/api/redeem", methods=["POST"])
def redeem_points():
    """Redeem points for discount."""
    body = request.get_json() or {}
    raw_phone = (body.get("phone") or "").strip()
    phone = "".join(c for c in raw_phone if c.isdigit())
    points_to_redeem = int(body.get("points", 0))

    if not phone:
        return jsonify({"error": "Phone required"}), 400
    if points_to_redeem <= 0:
        return jsonify({"error": "Points must be positive"}), 400

    data = _github_fetch()
    config = data.get("config", {})
    customers = data.get("customers", {})

    if phone not in customers:
        return jsonify({"error": "Customer not found"}), 404

    customer = customers[phone]
    if customer.get("points", 0) < points_to_redeem:
        return jsonify({
            "error": "Insufficient points",
            "available": customer["points"]
        }), 400

    value = calc_redemption_value(points_to_redeem, config)
    customer["points"] -= points_to_redeem

    txn = {
        "id": str(uuid.uuid4())[:8],
        "type": "redeem",
        "points": -points_to_redeem,
        "value": value,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    if "transactions" not in customer:
        customer["transactions"] = []
    customer["transactions"].append(txn)
    customers[phone] = customer
    data["customers"] = customers
    _github_push(data)

    return jsonify({
        "customer": customer,
        "transaction": txn,
        "value": value
    })

@app.route("/api/config", methods=["GET", "POST"])
def manage_config():
    """Get or update shop config."""
    data = _github_fetch()

    if request.method == "POST":
        body = request.get_json() or {}
        config = data.get("config", {})
        if "points_per_dollar" in body:
            config["points_per_dollar"] = int(body["points_per_dollar"])
        if "points_value_cents" in body:
            config["points_value_cents"] = int(body["points_value_cents"])
        if "shop_name" in body:
            config["shop_name"] = body["shop_name"]
        data["config"] = config
        _github_push(data)
        return jsonify({"config": config})

    return jsonify({"config": data.get("config", {})})

@app.route("/api/stats")
def get_stats():
    """Shop-wide stats."""
    data = _github_fetch()
    customers = data.get("customers", {})
    config = data.get("config", {})
    total_customers = len(customers)
    total_points = sum(c.get("points", 0) for c in customers.values())
    lifetime_points = sum(c.get("lifetime_points", 0) for c in customers.values())
    value = calc_redemption_value(total_points, config)

    return jsonify({
        "total_customers": total_customers,
        "points_outstanding": total_points,
        "outstanding_value": value,
        "lifetime_points": lifetime_points
    })


# ── Entry Point ──
if __name__ == "__main__":
    _load_token()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
