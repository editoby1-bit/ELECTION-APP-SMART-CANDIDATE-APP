/**
 * voice-worker.js — OutreachOS Robo-call Worker
 * 
 * Runs separately from wa-sender.
 * Watches Firestore for campaigns of type: 'voice'
 * Uses Africa's Talking (or swap for Twilio/Plivo).
 * 
 * Install: npm install africastalking express body-parser
 */

const AfricasTalking = require('africastalking')({
  apiKey:   process.env.AT_API_KEY,
  username: process.env.AT_USERNAME,
});
const voice = AfricasTalking.VOICE;

const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');

// ── Init ─────────────────────────────────────────────────────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('[ERROR] Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

try { admin.app(); } catch (e) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore();

// ── Express for callbacks ─────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * POST /voice/callback
 * Africa's Talking posts call events here.
 * Register this URL in your AT dashboard as the "Callback URL" for your voice channel.
 */
app.post('/voice/callback', async (req, res) => {
  try {
    const p = req.body || {};
    const sessionId = p.sessionId || p.session_id || '';
    const status    = p.status    || p.callStatus  || '';
    const from      = p.from      || p.source      || '';
    const to        = p.to        || p.destination || '';
    const dtmf      = p.dtmf      || p.digits      || '';
    const callId    = p.callId    || p.call_id     || '';

    // Log every event
    await db.collection('voiceLogs').add({
      sessionId, status, from, to, dtmf, callId,
      raw: p,
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // DTMF opt-out — pressing 2 or 9
    if (dtmf && ['2', '9'].includes(String(dtmf).trim())) {
      const phone = from.replace(/\D/g, '');
      const variants = [from, phone, '+' + phone];
      for (const ph of variants) {
        const snap = await db.collection('recipients').where('phone', '==', ph).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({ optedOut: true });
          await db.collection('voiceLogs').add({
            action: 'optOut', phone: ph, by: 'dtmf',
            time: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`[opt-out] ${ph} via DTMF`);
          break;
        }
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[callback err]', err.message);
    res.status(500).send('error');
  }
});

// ── Single call with logging ──────────────────────────────────────
async function placeCall(number, voiceFileUrl, campaignId, callerId) {
  const result = await voice.call({
    to:           [number],
    from:         callerId || 'VOICE',
    voiceFileUrl,
  });

  await db.collection('voiceLogs').add({
    type: 'outbound',
    campaignId: campaignId || null,
    to: number,
    voiceFileUrl,
    result,
    initiatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return result;
}

// ── Process one voice campaign ────────────────────────────────────
async function processVoiceCampaign(campaign) {
  const campaignRef = db.collection('campaigns').doc(campaign.id);
  console.log(`[voice campaign:${campaign.id}] Starting — ${campaign.name}`);

  const targetQuery = campaign.targetQuery || {};
  let q = db.collection('recipients').where('optedOut', '==', false);
  if (targetQuery.state)    q = q.where('state',    '==', targetQuery.state);
  if (targetQuery.lga)      q = q.where('lga',      '==', targetQuery.lga);
  if (targetQuery.ward)     q = q.where('ward',     '==', targetQuery.ward);
  if (targetQuery.language) q = q.where('language', '==', targetQuery.language);

  const throttleMs = campaign.throttleMs || 1000;
  const voiceUrl   = campaign.voiceUrl;
  const callerId   = campaign.callerId || null;

  if (!voiceUrl) {
    console.error(`[voice campaign:${campaign.id}] No voiceUrl set. Aborting.`);
    await campaignRef.update({ status: 'failed', error: 'No voiceUrl' });
    return;
  }

  let totalCalls = 0;
  let lastDoc = null;

  while (true) {
    let pageQuery = q.limit(500);
    if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);

    const snap = await pageQuery.get();
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      const recipient = doc.data();

      // Re-check opt-out
      const fresh = await doc.ref.get();
      if (fresh.data()?.optedOut) {
        console.log(`[skip] ${recipient.phone} opted out`);
        continue;
      }

      try {
        await placeCall(recipient.phone, voiceUrl, campaign.id, callerId);
        totalCalls++;
        console.log(`[call] ${recipient.phone} | campaign:${campaign.id}`);
        if (totalCalls % 25 === 0) {
          await campaignRef.update({ callsPlaced: totalCalls });
        }
      } catch (err) {
        console.error(`[call err] ${recipient.phone}:`, err.message);
        await db.collection('voiceLogs').add({
          type: 'error', campaignId: campaign.id,
          to: recipient.phone, error: err.message,
          time: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }

      // Throttle
      await sleep(throttleMs);
    }

    if (snap.docs.length < 500) break;
  }

  await campaignRef.update({
    status: 'completed',
    callsPlaced: totalCalls,
    progress: 100,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    _processing: admin.firestore.FieldValue.delete()
  });
  console.log(`[voice campaign:${campaign.id}] ✅ Done — ${totalCalls} calls placed`);
}

// ── Campaign Watcher ──────────────────────────────────────────────
async function watchVoiceCampaigns() {
  try {
    const snap = await db.collection('campaigns')
      .where('type', '==', 'voice')
      .where('status', 'in', ['scheduled', 'running'])
      .get();

    for (const doc of snap.docs) {
      const campaign = { id: doc.id, ...doc.data() };
      if (campaign._processing) continue;
      await doc.ref.update({ status: 'running', _processing: true });
      processVoiceCampaign(campaign).catch(async err => {
        console.error(`[voice fatal] ${campaign.id}:`, err.message);
        await doc.ref.update({ status: 'failed', error: err.message, _processing: admin.firestore.FieldValue.delete() });
      });
    }
  } catch (e) {
    console.error('[watchVoice err]', e.message);
  }
  setTimeout(watchVoiceCampaigns, 20000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[OutreachOS] Voice worker listening on :${PORT}`));
console.log('[OutreachOS] Voice worker starting…');
watchVoiceCampaigns().catch(console.error);
