// Africa's Talking voice sample with compliance, DTMF capture, opt-out handling and Firestore logging.
// Requirements: set AT_API_KEY and AT_USERNAME in env, and FIREBASE_SERVICE_ACCOUNT_JSON for Firestore logging.
// Install: npm install africastalking firebase-admin express body-parser
const AfricasTalking = require('africastalking')({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});
const voice = AfricasTalking.VOICE;

const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set - opt-out logging disabled');
} else {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore ? admin.firestore() : null;

// Simple Express endpoint to receive callbacks from Africa's Talking (or similar provider)
// This endpoint will handle call status, DTMF (keypress) events and log them to Firestore.
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Example callback route - provider should be configured to POST call events here.
app.post('/voice/callback', async (req, res) => {
  try {
    const payload = req.body || {};
    // Typical fields: sessionId, status, to, from, dtmf, direction, duration, callId
    const sessionId = payload.sessionId || payload.session_id || '';
    const status = payload.status || payload.callStatus || '';
    const from = payload.from || payload.source || '';
    const to = payload.to || payload.destination || '';
    const dtmf = payload.dtmf || payload.digits || '';
    const callId = payload.callId || payload.call_id || '';

    // Log to Firestore for auditing and compliance
    if (db) {
      await db.collection('voiceLogs').add({
        sessionId, status, from, to, dtmf, callId, raw: payload, receivedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // If user pressed the opt-out key (e.g., '2'), mark recipient as opted out
    // Adjust digit logic per your recorded message instruction
    if (dtmf && ['2','9'].includes(String(dtmf).trim())) {
      const phone = (from || '').replace('+','').replace(' ','');
      if (db && phone) {
        const snap = await db.collection('recipients').where('phone','==', phone).limit(1).get();
        if (!snap.empty) {
          const rid = snap.docs[0].id;
          await db.collection('recipients').doc(rid).update({ optedOut: true });
          await db.collection('voiceLogs').add({ action: 'optOut', phone, by: 'dtmf', time: admin.firestore.FieldValue.serverTimestamp() });
          console.log('Opt-out recorded for', phone);
        }
      }
    }

    // Respond 200 to provider
    res.status(200).send('OK');
  } catch (err) {
    console.error('voice callback err', err);
    res.status(500).send('error');
  }
});

// Example function to initiate a call with Africa's Talking using a pre-recorded message
async function call(number, voiceFileUrl, campaignId, options={}){
  try {
    // basic compliance note: include identification and opt-out instruction in the recording
    // options: { from: 'SENDER', maxRetries: 1 }
    const res = await voice.call({
      to: [number],
      from: options.from || 'VOICE',
      voiceFileUrl
    });

    // Log call attempt
    if (db) {
      await db.collection('voiceLogs').add({
        campaignId: campaignId || null,
        to: number,
        voiceFileUrl,
        result: res,
        initiatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res;
  } catch (e) {
    console.error('call err', e);
    if (db) {
      await db.collection('voiceLogs').add({ campaignId, to: number, error: String(e), time: admin.firestore.FieldValue.serverTimestamp() });
    }
    throw e;
  }
}

// Basic throttling queue for calls to avoid flooding: simple sequential with delay
let calling = false;
async function enqueueCall(number, voiceFileUrl, campaignId, options){
  // Respect rate: default 1 call per second (adjustable)
  const delayMs = (options && options.delayMs) || 1000;
  while (calling) await new Promise(r=>setTimeout(r, 200));
  calling = true;
  try {
    const r = await call(number, voiceFileUrl, campaignId, options);
    await new Promise(r=>setTimeout(r, delayMs));
    calling = false;
    return r;
  } catch(e){
    calling = false;
    throw e;
  }
}

module.exports = { app, enqueueCall, call };
