"""
SMS Proxy — Free SMS via carrier email gateways
Deploy to Render (free tier) as a Web Service
No API keys, no limits, no cost.

Build command: pip install flask gunicorn
Start command: gunicorn app:app
"""

import smtplib
import ssl
from email.mime.text import MIMEText
from flask import Flask, request, jsonify
import os

app = Flask(__name__)

# US carrier email-to-SMS gateways (free, no auth required)
CARRIERS = [
    "{}@vtext.com",       # Verizon
    "{}@txt.att.net",     # AT&T
    "{}@tmomail.net",     # T-Mobile
    "{}@messaging.sprintpcs.com",  # Sprint
    "{}@mymetropcs.com",  # MetroPCS
    "{}@msg.fi.google.com", # Google Fi
    "{}@email.uscc.net",  # US Cellular
]

# Use a free Gmail app password or any SMTP server
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")

@app.route("/send", methods=["POST"])
def send_sms():
    data = request.get_json(silent=True) or {}
    phone = (data.get("phone") or "").strip()
    message = (data.get("message") or "").strip()

    if not phone or len(phone) < 10:
        return jsonify({"ok": False, "error": "Valid 10-digit phone required"}), 400
    if not message:
        return jsonify({"ok": False, "error": "Message required"}), 400

    # Clean phone to digits only
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) > 10:
        digits = digits[-10:]  # Take last 10 digits

    msg = MIMEText(message)
    msg["From"] = SMTP_USER or "rewards@smokeshop.com"

    delivered = False
    errors = []

    for template in CARRIERS:
        to_addr = template.format(digits)
        msg["To"] = to_addr
        try:
            ctx = ssl.create_default_context()
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
                server.starttls(context=ctx)
                if SMTP_USER and SMTP_PASS:
                    server.login(SMTP_USER, SMTP_PASS)
                server.sendmail(msg["From"], [to_addr], msg.as_string())
            delivered = True
        except Exception as e:
            errors.append(f"{template.split('@')[1]}: {e}")

    return jsonify({
        "ok": delivered,
        "phone": digits,
        "attempted": len(CARRIERS),
        "errors": errors[:3] if not delivered else []
    })

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "smtp": bool(SMTP_USER and SMTP_PASS)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
