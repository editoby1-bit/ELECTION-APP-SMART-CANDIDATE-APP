/**
 * wa-sender.js — OutreachOS WhatsApp Worker
 * 
 * Fixes from audit:
 *  - Full targeting: state, lga, ward, language, group
 *  - Media sending: image, video, audio, document
 *  - Proper Firestore pagination (no 5000 limit hack)
 *  - Correct campaign progress tracking
 *  - Better error recovery per-recipient
 *  - Connection retry logic
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@adiwajshing/baileys');
const admin = require('firebase-admin');
const PQueue = require('p-queue').default;
const fs = require('fs');
const path = require('path');

// ── Init ─────────────────────────────────────────────────────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('[ERROR] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
});
const db = admin.firestore();

const SENDER_AUTH_DIR = './sender_auth';
if (!fs.existsSync(SENDER_AUTH_DIR)) fs.mkdirSync(SENDER_AUTH_DIR);

// Active socket registry
const activeSockets = {};

// ── Queue ─────────────────────────────────────────────────────────
const queue = new PQueue({ concurrency: 3 });

// ── Sender Management ─────────────────────────────────────────────
async function loadActiveSenders() {
  const snap = await db.collection('senders').where('status', '==', 'active').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getSenderDailySentCount(senderId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const snap = await db.collection('sends')
    .where('senderId', '==', senderId)
    .where('attemptAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .count()
    .get();
  return snap.data().count;
}

async function createSocket(sender) {
  const senderDir = path.join(SENDER_AUTH_DIR, sender.id);
  if (!fs.existsSync(senderDir)) fs.mkdirSync(senderDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(senderDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: 60000,
    browser: ['OutreachOS', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sender.id}] Disconnected. Code: ${code}`);
      if (code !== DisconnectReason.loggedOut) {
        console.log(`[${sender.id}] Reconnecting in 5s…`);
        setTimeout(() => createSocket(sender).then(s => { activeSockets[sender.id] = s; }), 5000);
      } else {
        console.log(`[${sender.id}] Logged out. Marking inactive.`);
        await db.collection('senders').doc(sender.id).update({ status: 'logged_out' });
        delete activeSockets[sender.id];
      }
    } else if (connection === 'open') {
      console.log(`[${sender.id}] ✅ Connected`);
    }
  });

  // Handle incoming messages — opt-out + log replies
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = (msg.key.remoteJid || '').replace('@s.whatsapp.net', '');
      const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';

      // Log reply
      try {
        await db.collection('responses').add({
          phone: from, text, senderId: sender.id,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.error('[reply log err]', e.message); }

      // Auto opt-out
      if (['stop', 'unsubscribe', 'end', 'quit'].includes(text.trim().toLowerCase())) {
        try {
          const snap = await db.collection('recipients').where('phone', '==', from).limit(1).get();
          if (!snap.empty) {
            await snap.docs[0].ref.update({ optedOut: true });
            await db.collection('voiceLogs').add({
              action: 'optOut', phone: from, by: 'whatsapp_reply',
              time: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[opt-out] ${from} opted out via WhatsApp reply`);
          }
        } catch (e) { console.error('[opt-out err]', e.message); }
      }
    }
  });

  return sock;
}

// ── Sender picker (round robin, respects daily limit) ─────────────
let senderIdx = 0;
async function pickAvailableSender(senders) {
  for (let i = 0; i < senders.length; i++) {
    const idx = (senderIdx + i) % senders.length;
    const sender = senders[idx];
    const sentToday = await getSenderDailySentCount(sender.id);
    const dailyLimit = sender.dailyLimit || 3000;
    if (sentToday < dailyLimit) {
      senderIdx = (idx + 1) % senders.length;
      return sender;
    }
  }
  return null; // all senders at daily limit
}

// ── Build Firestore query from targetQuery ────────────────────────
function buildRecipientsQuery(targetQuery) {
  let q = db.collection('recipients').where('optedOut', '==', false);
  if (targetQuery.state)    q = q.where('state',    '==', targetQuery.state);
  if (targetQuery.lga)      q = q.where('lga',      '==', targetQuery.lga);
  if (targetQuery.ward)     q = q.where('ward',     '==', targetQuery.ward);
  if (targetQuery.language) q = q.where('language', '==', targetQuery.language);
  if (targetQuery.group)    q = q.where('group',    '==', targetQuery.group);
  return q;
}

// ── Build WA message payload by type ─────────────────────────────
function buildMessagePayload(campaign, recipient) {
  const text = (campaign.messageTemplate || '')
    .replace(/{name}/g,  recipient.name  || '')
    .replace(/{lga}/g,   recipient.lga   || '')
    .replace(/{ward}/g,  recipient.ward  || '')
    .replace(/{state}/g, recipient.state || '');

  const type = campaign.messageType || 'text';

  if (type === 'text' || !campaign.mediaUrl) {
    return { text };
  }

  const caption = text;
  const url = campaign.mediaUrl;

  switch (type) {
    case 'image':    return { image: { url }, caption };
    case 'video':    return { video: { url }, caption };
    case 'audio':    return { audio: { url }, mimetype: 'audio/mpeg', ptt: false };
    case 'document': return { document: { url }, mimetype: 'application/pdf', caption, fileName: 'campaign.pdf' };
    default:         return { text };
  }
}

// ── Process one campaign ──────────────────────────────────────────
async function processCampaign(campaign, senders) {
  const campaignRef = db.collection('campaigns').doc(campaign.id);
  console.log(`[campaign:${campaign.id}] Starting — ${campaign.name}`);

  const q = buildRecipientsQuery(campaign.targetQuery || {});

  // Paginate through recipients in batches of 500
  let lastDoc = null;
  let totalSent = 0;
  let totalCount = 0;

  // Count first for progress tracking
  try {
    const countSnap = await q.count().get();
    totalCount = countSnap.data().count;
    console.log(`[campaign:${campaign.id}] ${totalCount} eligible recipients`);
  } catch (e) { console.error('[count err]', e.message); }

  while (true) {
    let pageQuery = q.limit(500);
    if (lastDoc) pageQuery = pageQuery.startAfter(lastDoc);

    const snap = await pageQuery.get();
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    const recipients = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    for (const recipient of recipients) {
      await queue.add(async () => {
        try {
          // Re-check opt-out (may have changed mid-campaign)
          const recSnap = await db.collection('recipients').doc(recipient.id).get();
          if (recSnap.exists && recSnap.data().optedOut) {
            console.log(`[skip] ${recipient.phone} opted out`);
            return;
          }

          const sender = await pickAvailableSender(senders);
          if (!sender) {
            console.warn('[warn] All senders at daily limit. Pausing campaign.');
            await campaignRef.update({ status: 'paused', pauseReason: 'daily_limit_reached' });
            queue.pause();
            return;
          }

          const sock = activeSockets[sender.id];
          if (!sock) {
            console.warn(`[warn] Socket missing for sender ${sender.id}`);
            return;
          }

          // Humanized random delay (300ms – 1500ms)
          await sleep(300 + Math.random() * 1200);

          const jid = recipient.phone.replace(/\D/g, '') + '@s.whatsapp.net';
          const payload = buildMessagePayload(campaign, recipient);
          await sock.sendMessage(jid, payload);

          // Log send
          await db.collection('sends').add({
            campaignId: campaign.id,
            recipientId: recipient.id,
            senderId: sender.id,
            phone: recipient.phone,
            messageType: campaign.messageType || 'text',
            status: 'sent',
            attemptAt: admin.firestore.FieldValue.serverTimestamp()
          });

          totalSent++;

          // Update campaign progress every 50 sends
          if (totalSent % 50 === 0) {
            const progress = totalCount > 0 ? Math.round((totalSent / totalCount) * 100) : 0;
            await campaignRef.update({ sent: totalSent, progress });
          }

          console.log(`[sent] ${recipient.phone} | campaign:${campaign.id} | via:${sender.id}`);
        } catch (err) {
          console.error(`[send err] ${recipient.phone}:`, err.message);
          // Log failure
          await db.collection('sends').add({
            campaignId: campaign.id,
            recipientId: recipient.id,
            phone: recipient.phone,
            status: 'failed',
            error: err.message,
            attemptAt: admin.firestore.FieldValue.serverTimestamp()
          }).catch(() => {});
        }
      });
    }

    await queue.onIdle();
    if (snap.docs.length < 500) break; // last page
  }

  await campaignRef.update({
    status: 'completed',
    sent: totalSent,
    progress: 100,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    _processing: admin.firestore.FieldValue.delete()
  });
  console.log(`[campaign:${campaign.id}] ✅ Completed — ${totalSent} sent`);
}

// ── Campaign Watcher ──────────────────────────────────────────────
async function watchCampaigns() {
  try {
    const snap = await db.collection('campaigns')
      .where('status', 'in', ['scheduled', 'running'])
      .where('type', 'in', ['whatsapp', null]) // only WA campaigns
      .get();

    const senders = await loadActiveSenders();
    if (senders.length === 0) {
      console.log('[worker] No active senders. Scan QR codes first.');
    } else {
      // Ensure sockets are open
      for (const sender of senders) {
        if (!activeSockets[sender.id]) {
          activeSockets[sender.id] = await createSocket(sender).catch(e => {
            console.error(`[socket err] ${sender.id}:`, e.message);
            return null;
          });
        }
      }
    }

    for (const doc of snap.docs) {
      const campaign = { id: doc.id, ...doc.data() };
      if (campaign._processing) continue;
      if (!campaign.type || campaign.type === 'whatsapp') {
        await doc.ref.update({ status: 'running', _processing: true });
        processCampaign(campaign, senders).catch(async err => {
          console.error(`[campaign fatal] ${campaign.id}:`, err.message);
          await doc.ref.update({ status: 'failed', error: err.message, _processing: admin.firestore.FieldValue.delete() });
        });
      }
    }
  } catch (e) {
    console.error('[watchCampaigns err]', e.message);
  }

  setTimeout(watchCampaigns, 15000); // poll every 15s
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────
console.log('[OutreachOS] WhatsApp worker starting…');
watchCampaigns().catch(console.error);
