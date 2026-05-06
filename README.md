
# Message Platform Starter (The Shift)

This starter repo builds a Firebase + Baileys WhatsApp automation prototype.
You will need Firebase credentials and to run the wa-sender worker on a small VPS.

Included:
- wa-sender.js
- firebase-functions_index.js
- dashboard_index.html
- package.json
- .env.sample
- scripts/import_recipients.js
- at-voice-sample.js
- firestore.rules
- firebase.json
- pm2.json

Follow README instructions for setup, scanning QR and running the sender.


## Automated safety features added
- Per-sender daily limits enforced (read from senders.dailyLimit or default 3000).
- Randomized send delays to humanize traffic.
- Opt-out detection: recipients replying STOP/UNSUBSCRIBE/END/QUIT are auto-flagged and skipped.
- Sender rotation logic remains and is used to spread load across numbers.


## Voice (Robo-call) compliance and logging added
- Express callback endpoint /voice/callback to receive status and DTMF events from the voice provider.
- DTMF '2' or '9' treated as opt-out and will mark recipient.optedOut=true in Firestore.
- enqueueCall provides simple throttling (1 call/sec default) to avoid mass bursts.
- Logs written to voiceLogs collection for audit and escalation.


## Final additions by discretion
- Dashboard improved with voice campaign UI and compliance logs view.
- Added firebase-voice-functions.js for Firebase-hosted voice callbacks.
- Added README-FIRST-RUN.md with exact setup order.
