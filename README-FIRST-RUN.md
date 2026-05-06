# FIRST RUN GUIDE — Message Platform Starter

## What this ZIP now includes
1. WhatsApp automation worker with sender rotation, per-sender daily limits, randomized delay, and automatic opt-out handling.
2. Robo-call module with voice callback endpoint, DTMF opt-out handling, voiceLogs audit trail, and simple call throttling.
3. Dashboard UI with WhatsApp campaign screen, Robo call campaign screen, and Compliance logs view.

## First practical setup order
1. Create Firebase project.
2. Enable Firestore.
3. Create Firebase service account.
4. Put the service account JSON into FIREBASE_SERVICE_ACCOUNT_JSON.
5. Create Firestore collections:
   recipients, senders, campaigns, sends, responses, voiceLogs.
6. Import a small test recipient list first.
7. Add one sender document:
   senders/test_sender_1:
   { "status": "active", "dailyLimit": 300 }
8. Run:
   npm install
   node wa-sender.js
9. Scan the QR code with your WhatsApp sender phone.
10. Create a test campaign with only 5-10 recipients first.

## Robo-call setup
- Use Africa's Talking, Twilio, or another programmable voice provider.
- Record your message with this opt-out line:
  "To stop receiving these calls, press 2."
- Configure provider callback URL to /voice/callback
  OR use the Firebase Functions voiceCallback endpoint from firebase-voice-functions.js.
