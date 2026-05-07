# OutreachOS v2 — Deployment Checklist
## From zero to live in one session

---

## What you need before starting

- A laptop with internet access
- A Firebase Google account (free)
- A VPS or server (DigitalOcean, Hetzner, or any Ubuntu 20+ box — $6/month works)
- 1–3 dedicated WhatsApp phone numbers (SIM cards only used for sending)
- An Africa's Talking account for robo calls (https://africastalking.com)

---

## PHASE 1 — Firebase Setup (15 minutes)

### 1.1 Create Firebase Project
1. Go to https://console.firebase.google.com
2. Click **Add project**
3. Name it: `outreachos-prod`
4. Disable Google Analytics → **Create project**
5. Wait for setup to complete

### 1.2 Enable Firestore
1. Left sidebar → **Build** → **Firestore Database**
2. Click **Create database**
3. Select **Start in production mode**
4. Choose region: **europe-west1** (closest to Nigeria with good latency)
5. Click **Enable**

### 1.3 Enable Authentication
1. Left sidebar → **Build** → **Authentication**
2. Click **Get started**
3. Click **Email/Password** → Enable → **Save**
4. Go to **Users** tab → **Add user**
5. Enter your admin email and a strong password
6. **Save** — this is your dashboard login

### 1.4 Get Firebase Config (for dashboard)
1. Left sidebar → **Project Settings** (gear icon)
2. Scroll to **Your apps** → Click **</>** (web icon)
3. Register app name: `outreachos-dashboard` → **Register app**
4. Copy the `firebaseConfig` object (you'll paste it into index.html)

### 1.5 Generate Service Account (for workers)
1. **Project Settings** → **Service accounts** tab
2. Click **Generate new private key** → **Generate key**
3. Download the JSON file
4. Rename it: `service-account.json`
5. **Keep this file safe — never commit to Git**

---

## PHASE 2 — Dashboard Deployment (10 minutes)

### 2.1 Update Firebase Config
Open `dashboard/index.html` on your computer.
Find the section that says:
```
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  ...
```
Replace the entire object with the config you copied in step 1.4.
Save the file.

### 2.2 Install Firebase CLI
On your computer (Mac/Windows/Linux):
```bash
npm install -g firebase-tools
```

If you don't have Node.js:
- Download from https://nodejs.org (LTS version)

### 2.3 Login and Deploy
```bash
firebase login
# A browser window opens — sign in with your Google account

cd /path/to/outreachos-v2/platform-rebuild
firebase use --add
# Select your project from the list, alias: default

firebase deploy --only hosting,firestore:rules,firestore:indexes
```

You will see output like:
```
✔  Deploy complete!
Hosting URL: https://outreachos-prod.web.app
```

### 2.4 Test the Dashboard
1. Open the URL shown above
2. Log in with the admin email and password you created in step 1.3
3. You should see the dashboard with empty stats — this is correct

---

## PHASE 3 — VPS Worker Setup (20 minutes)

### 3.1 Create a VPS
Recommended: DigitalOcean Droplet or Hetzner Cloud
- OS: Ubuntu 22.04 LTS
- Size: 2GB RAM minimum (4GB if running both workers + WhatsApp sessions)
- Region: Europe or US (latency to Nigeria is acceptable)

### 3.2 Connect to Your VPS
```bash
ssh root@YOUR_VPS_IP
```

### 3.3 Install Node.js 18 and PM2
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
npm install -g pm2
node --version   # should show v18.x.x
```

### 3.4 Upload Project Files
From your local machine:
```bash
scp -r /path/to/outreachos-v2/platform-rebuild root@YOUR_VPS_IP:/opt/outreachos
```

Or clone from Git if you push it to a private repo.

### 3.5 Install Dependencies
```bash
cd /opt/outreachos
npm install
```

### 3.6 Set Environment Variables
```bash
nano /etc/environment
```

Add these lines (replace with your actual values):
```
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"outreachos-prod",...}'
AT_API_KEY=your_africa_talking_api_key
AT_USERNAME=your_africa_talking_username
```

To get the JSON on one line:
```bash
# On your local machine:
cat service-account.json | tr -d '\n'
```

Paste the result as the value for `FIREBASE_SERVICE_ACCOUNT_JSON`.

Load the variables:
```bash
source /etc/environment
```

### 3.7 Open Firewall Port for Voice Callbacks
```bash
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw allow 3001  # Voice callback
ufw enable
```

### 3.8 Start Workers with PM2
```bash
cd /opt/outreachos
pm2 start pm2.ecosystem.json
pm2 status
```

You should see:
```
┌──────────────────────┬─────────┬──────┬─────────┐
│ Name                 │ Status  │ CPU  │ Memory  │
├──────────────────────┼─────────┼──────┼─────────┤
│ outreachos-wa        │ online  │ 0%   │ 80mb    │
│ outreachos-voice     │ online  │ 0%   │ 50mb    │
└──────────────────────┴─────────┴──────┴─────────┘
```

### 3.9 Make PM2 Survive Reboots
```bash
pm2 save
pm2 startup
# Copy and run the command it gives you
```

---

## PHASE 4 — WhatsApp Sender Setup (5 min per sender)

### 4.1 Add Sender in Dashboard
1. Open dashboard → **Senders** → **+ Add Sender**
2. Sender ID: `line_01` (or any label you choose)
3. Daily limit: `300` (safe starting point)
4. Click **Add Sender**

### 4.2 Scan the QR Code
On the VPS:
```bash
pm2 logs outreachos-wa
```

A QR code will appear in the terminal output.

On the WhatsApp phone (the sender SIM):
1. Open WhatsApp
2. Tap ⋮ (three dots) → **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code from the terminal

You will see: `[line_01] ✅ Connected`

Repeat for each sender line. Sessions are saved — you only scan once per phone.

---

## PHASE 5 — Africa's Talking Voice Setup

### 5.1 Get API Key
1. Sign up at https://africastalking.com
2. Go to your dashboard → **Settings** → **API Key**
3. Copy the key — you already set it in step 3.6

### 5.2 Set Voice Callback URL
1. Africa's Talking dashboard → **Voice** → **Phone Numbers**
2. Select your number → **Update**
3. Set **Callback URL**: `http://YOUR_VPS_IP:3001/voice/callback`
4. Save

### 5.3 Test a Voice Campaign
1. Dashboard → **Robo Calls** → **New Voice Campaign**
2. Campaign name: `Test — 5 Numbers`
3. Target: pick a specific state and LGA with known recipients
4. Voice file URL: upload a short test MP3 to Google Drive (make it public) and use the direct link
5. Throttle: 1 call / 5 seconds
6. Click **Launch Voice Campaign**

---

## PHASE 6 — Import Recipients and Test

### 6.1 Prepare Your CSV
Columns required:
```
phone,name,state,lga,ward,community,language,group
```

Phone formats accepted:
- `08031234567` → auto-converted to `+2348031234567`
- `+2348031234567` → used as-is

### 6.2 Run Import
On the VPS:
```bash
cd /opt/outreachos
node scripts/import_recipients.js /path/to/your/list.csv
```

You'll see live progress.

### 6.3 Verify in Dashboard
Dashboard → **Recipients** → you should see your contacts

### 6.4 Send Your First Test Campaign
1. Dashboard → **WhatsApp** → **Compose Campaign**
2. Name: `First Test`
3. Target: pick 1 LGA with a small number of contacts
4. Message: `Hello {name}, this is a test message from OutreachOS.`
5. Click **Estimate Reach** — confirm the number is small
6. Click **Launch Campaign**
7. Watch **Dashboard** → **Live Activity** for confirmation

---

## PHASE 7 — Go-Live Checklist

Before running a real campaign:

- [ ] Tested with 5–10 known numbers successfully
- [ ] QR codes scanned for all sender lines
- [ ] Voice callback URL is live and returning 200
- [ ] Recipients database is imported and verified
- [ ] Daily limits set conservatively (300/sender to start)
- [ ] Test opt-out: reply STOP from a test phone, verify it's marked in Firestore
- [ ] Test DTMF opt-out: press 2 during a test call, verify Firestore update
- [ ] Admin login confirmed on the live dashboard URL
- [ ] VPS PM2 startup configured (survives reboots)

---

## Common Issues

**QR code not appearing**
```bash
pm2 logs outreachos-wa --lines 50
# Look for connection errors
# Delete auth folder and retry:
rm -rf /opt/outreachos/sender_auth/line_01
pm2 restart outreachos-wa
```

**Firestore permission denied**
- Check that `firestore.rules` was deployed: `firebase deploy --only firestore:rules`
- Verify user is authenticated in the dashboard

**Voice callback not receiving events**
- Check port 3001 is open: `ufw status`
- Check worker is running: `pm2 status`
- Test manually: `curl -X POST http://YOUR_VPS_IP:3001/voice/callback -d "sessionId=test&status=ringing&from=+234800&dtmf="`

**Sends not processing**
- The worker polls every 15 seconds — wait up to 30 seconds
- Check campaign status in Firestore console: should change from `scheduled` → `running`
- Check worker logs: `pm2 logs outreachos-wa`
