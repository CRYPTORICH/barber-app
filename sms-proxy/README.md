# SMS Proxy — Free SMS via carrier email gateways
# Deploy this folder to Render.com (free tier)

## One-time setup:
# 1. Go to render.com → New Web Service → connect this repo folder
# 2. Build command: pip install -r requirements.txt
# 3. Start command: gunicorn app:app
# 4. Add environment variables:
#    SMTP_USER = dejesusrichard89@gmail.com
#    SMTP_PASS = (Gmail app password — generate at myaccount.google.com/apppasswords)
# 5. Deploy → get URL like https://sms-proxy-xxxx.onrender.com

## To get a Gmail app password (free, 500 emails/day):
# 1. Go to myaccount.google.com → Security → 2-Step Verification (must be ON)
# 2. Search "App passwords" → create one named "SMS Proxy"
# 3. Copy the 16-char password → paste as SMTP_PASS on Render

## No Gmail? Options:
# - SendGrid free tier (100/day): signup.sendgrid.com
# - Mailgun free tier (100/day): mailgun.com
# - Brevo free tier (300/day): brevo.com
