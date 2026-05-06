/**
 * firebase-voice-functions.js
 * Optional Firebase Functions wrapper for voice callbacks.
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
try { admin.app(); } catch(e) { admin.initializeApp(); }
const db = admin.firestore();

exports.voiceCallback = functions.https.onRequest(async (req, res) => {
  try {
    const payload = req.body || {};
    const sessionId = payload.sessionId || payload.session_id || '';
    const status = payload.status || payload.callStatus || '';
    const from = payload.from || payload.source || '';
    const to = payload.to || payload.destination || '';
    const dtmf = payload.dtmf || payload.digits || '';
    const callId = payload.callId || payload.call_id || '';

    await db.collection('voiceLogs').add({
      sessionId, status, from, to, dtmf, callId, raw: payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (dtmf && ['2','9'].includes(String(dtmf).trim())) {
      const phone = (from || '').replace('+','').replace(/\s/g,'');
      const snap = await db.collection('recipients').where('phone','==', phone).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({ optedOut: true });
        await db.collection('voiceLogs').add({
          action: 'optOut', phone, by: 'dtmf',
          time: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});
