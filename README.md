# OutreachOS v2.0 — Setup Guide

## What's in this package

| File | Purpose |
|---|---|
| `dashboard/index.html` | Full web dashboard (deploy to Firebase Hosting) |
| `wa-sender.js` | WhatsApp broadcast worker (runs on VPS) |
| `voice-worker.js` | Robo-call worker + /voice/callback endpoint |
| `scripts/import_recipients.js` | CSV import tool |
| `data/sample_recipients.csv` | Sample CSV showing required columns |
| `firestore.rules` | Firestore security rules |
| `firestore.indexes.json` | Required compound indexes |
| `pm2.ecosystem.json` | PM2 config for both workers |

---

## Step 1 — Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **Add Project** → name it (e.g. `outreachos-prod`)
3. Disable Google Analytics (not needed) → **Create Project**

---

## Step 2 — Enable Firestore

1. In Firebase console → **Firestore Database** → **Create database**
2. Choose **Production mode** (rules handle access)
3. Pick a region close to Nigeria: `europe-west1` or `us-central1`

---

## Step 3 — Create Service Account

1. Firebase console → **Project Settings** (gear icon) → **Service Accounts**
2. Click **Generate new private key** → Download JSON file
3. Keep this file safe — it gives full database access

---

## Step 4 — Enable Firebase Auth

1. Firebase console → **Authentication** → **Get Started**
2. Enable **Email/Password** provider
3. Go to **Users** tab → **Add user**
4. Enter your admin email and password (this is your dashboard login)

---

## Step 5 — Deploy Security Rules and Indexes

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # select your project
firebase deploy --only firestore:rules,firestore:indexes
```

---

## Step 6 — Update Dashboard Config

Open `dashboard/index.html` and find this section near the top:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  ...
};
```

Replace with your actual config from:
Firebase Console → Project Settings → General → Your apps → Firebase SDK snippet → Config

---

## Step 7 — Deploy Dashboard

```bash
firebase deploy --only hosting
```

Your dashboard will be live at: `https://YOUR_PROJECT.web.app`

---

## Step 8 — Set Up the VPS Worker

On your VPS (Ubuntu 20+):

```bash
# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
npm install -g pm2

# Upload your project files to the VPS
# (use scp, rsync, or git clone your repo)

cd /your/project/folder
npm install

# Set your service account JSON as an env variable
export FIREBASE_SERVICE_ACCOUNT_JSON='{ "type": "service_account", ... }'

# For voice worker, also set:
export AT_API_KEY='your_africa_talking_api_key'
export AT_USERNAME='your_at_username'

# Add to /etc/environment or .bashrc to persist after reboot
```

---

## Step 9 — Start Workers with PM2

```bash
# Start both workers
pm2 start pm2.ecosystem.json

# Check status
pm2 status

# View live logs
pm2 logs outreachos-wa
pm2 logs outreachos-voice

# Auto-restart on server reboot
pm2 save
pm2 startup
```

---

## Step 10 — Scan WhatsApp QR Code

When `wa-sender` starts for the first time, a QR code will appear in the terminal.

```bash
pm2 logs outreachos-wa
```

Scan the QR code with your sender WhatsApp phone:
→ WhatsApp → ⋮ Menu → **Linked Devices** → **Link a Device**

Each sender line needs its own QR scan once. After that, sessions are saved in `./sender_auth/`.

---

## Step 11 — Import Recipients

```bash
# Test with the sample file first
node scripts/import_recipients.js data/sample_recipients.csv

# Then import your full list
node scripts/import_recipients.js /path/to/your/full_list.csv
```

CSV columns: `phone, name, state, lga, ward, community, language, group`

---

## Step 12 — Configure Voice Callback (for Robo Calls)

1. In Africa's Talking dashboard → Voice → Settings
2. Set Callback URL to: `http://YOUR_VPS_IP:3001/voice/callback`
3. Make sure port 3001 is open in your firewall:
   ```bash
   sudo ufw allow 3001
   ```

If you want HTTPS (recommended), put Nginx in front:
```nginx
server {
  listen 443 ssl;
  server_name your-domain.com;
  location /voice/callback {
    proxy_pass http://localhost:3001;
  }
}
```

---

## Firestore Collections (auto-created on first use)

| Collection | Purpose |
|---|---|
| `recipients` | Contact database — phone, name, state, lga, ward, language, group, optedOut |
| `senders` | WhatsApp sender lines — status, dailyLimit |
| `campaigns` | Campaign records — type, status, targetQuery, messageTemplate |
| `sends` | Log of every message sent |
| `responses` | Incoming WhatsApp replies |
| `voiceLogs` | Call logs and opt-out events |

---

## Adding a Sender Line in Dashboard

1. Log into dashboard → **Senders** → **+ Add Sender**
2. Enter Sender ID (e.g. `line_01`) and daily limit
3. Restart the WA worker — it will prompt you to scan the QR for that sender

---

## Robo Call Recording Tips

Your voice recording MUST include this at the end:

> *"To stop receiving these calls, press 2."*

The system automatically detects the keypress and marks the recipient as opted out.

---

## Next Steps (not yet built)

- [ ] Field monitoring module (Election Eye) — agents submit photos/reports
- [ ] SMS channel support
- [ ] Role-based access (super admin vs. campaign manager)
- [ ] Scheduled campaign delivery (send at specific time)
- [ ] Analytics charts (delivery rate by LGA, response rate trends)
