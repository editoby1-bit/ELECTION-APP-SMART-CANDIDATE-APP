/**
 * wa-sender.js - Baileys based WhatsApp sender (starter)
 */ 
const { default: makeWASocket, useMultiFileAuthState } = require('@adiwajshing/baileys');
const admin = require('firebase-admin');
const PQueue = require('p-queue').default;
const fs = require('fs');
const path = require('path');

if(!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env. Set the service account json string.");
  process.exit(1);
}

const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(SERVICE_ACCOUNT)
});
const db = admin.firestore();

const SENDER_AUTH_DIR = './sender_auth';
if (!fs.existsSync(SENDER_AUTH_DIR)) fs.mkdirSync(SENDER_AUTH_DIR);

const queue = new PQueue({ concurrency: 5 });

async function loadSenders() {
  const snap = await db.collection('senders').where('status', '==', 'active').get();
  const senders = [];
  snap.forEach(doc => senders.push({ id: doc.id, ...doc.data() }));
  return senders;
}

async function createSocketForSender(sender) {
  const senderDir = path.join(SENDER_AUTH_DIR, sender.id);
  if (!fs.existsSync(senderDir)) fs.mkdirSync(senderDir);

  const { state, saveCreds } = await useMultiFileAuthState(senderDir);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: undefined
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      console.log(`[${sender.id}] connection closed`);
    } else if (connection === 'open') {
      console.log(`[${sender.id}] connected`);
    }
  });

  sock.ev.on('messages.upsert', async m => {
    try {
      const msg = m.messages[0];
      if (!msg.message) return;
      const from = msg.key.remoteJid ? msg.key.remoteJid.replace('@s.whatsapp.net','') : null;
      const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
      await db.collection('responses').add({
        phone: from,
        text,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        senderId: sender.id
      });
      console.log('[reply] from', from, text);

      // Auto-opt-out handling: if user replied STOP or UNSUBSCRIBE set optedOut flag
      try {
        const txtLower = (text || '').toLowerCase();
        if (['stop','unsubscribe','end','quit'].includes(txtLower.trim())) {
          const r = await db.collection('recipients').where('phone','==', from).limit(1).get();
          if (!r.empty) {
            const rid = r.docs[0].id;
            await db.collection('recipients').doc(rid).update({ optedOut: true });
            console.log('Opt-out recorded for', from);
          }
        }
      } catch(e) { console.error('optout err', e); }

    } catch (err) {
      console.error('reply handler err', err);
    }
  });

  return sock;
}

let senderIndex = 0;
async function pickSender(senders) {
  if (!senders || senders.length === 0) throw new Error('No senders active');
  senderIndex = (senderIndex + 1) % senders.length;
  return senders[senderIndex];
}

async function watchCampaigns() {
  const snapshot = await db.collection('campaigns').where('status','in', ['scheduled','running']).get();
  for (const doc of snapshot.docs) {
    const campaign = { id: doc.id, ...doc.data() };
    if (campaign._processing) continue;
    if (campaign.status === 'scheduled' || campaign.status === 'running') {
      await doc.ref.update({ status: 'running', _processing: true });
      processCampaign(campaign).catch(err => console.error('processCampaign err', err));
    }
  }
  setTimeout(watchCampaigns, 10000);
}

async function processCampaign(campaign) {
  try {
    console.log('Processing campaign', campaign.id, campaign.name);
    let recipientsQuery = db.collection('recipients');
    if (campaign.targetQuery && campaign.targetQuery.lga) {
      recipientsQuery = recipientsQuery.where('lga', '==', campaign.targetQuery.lga);
    }
    const recipientSnapshot = await recipientsQuery.limit(5000).get();
    const recipients = recipientSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    const senders = await loadSenders();
    if (senders.length === 0) {
      console.error('No active senders. Campaign paused.');
      await db.collection('campaigns').doc(campaign.id).update({ status: 'paused' });
      return;
    }
    const sockets = {};
    for (const s of senders) {
      sockets[s.id] = await createSocketForSender(s).catch(e => { console.error('socket create err', e); return null; });
    }
    for (const recipient of recipients) {
      queue.add(async () => {
        try {
          // OPT-OUT check: skip if recipient opted out
          const recRef = await db.collection('recipients').doc(recipient.id).get();
          const recData = recRef.exists ? recRef.data() : null;
          if (recData && recData.optedOut) {
            console.log('Skipping opted-out', recipient.phone);
            return;
          }

          // pick sender and enforce per-sender daily limit
          const sender = await pickSender(senders);
          const senderDoc = await db.collection('senders').doc(sender.id).get();
          const senderInfo = senderDoc.exists ? senderDoc.data() : {};
          const dailyLimit = senderInfo.dailyLimit || 3000; // default safe cap
          
          // count sends today for this sender
          const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
          const snaps = await db.collection('sends')
            .where('senderId','==', sender.id)
            .where('attemptAt','>=', admin.firestore.Timestamp.fromDate(startOfDay))
            .get();
          const sentToday = snaps.size || 0;
          if (sentToday >= dailyLimit) {
            console.log(`Sender ${sender.id} reached daily limit (${dailyLimit}). Skipping this recipient.`);
            return;
          }

          const sock = sockets[sender.id];
          if (!sock) throw new Error('sender socket missing');

          // small humanized random delay to avoid rate patterns (200ms - 1200ms)
          const randDelay = Math.floor(200 + Math.random() * 1000);
          await new Promise(res => setTimeout(res, randDelay));

          // craft personalized message and send
          let text = campaign.messageTemplate || '';
          text = text.replace(/\{name\}/g, recipient.name || '');
          const jid = recipient.phone + '@s.whatsapp.net';
          const res = await sock.sendMessage(jid, { text });

          // log send
          await db.collection('sends').add({
            campaignId: campaign.id,
            recipientId: recipient.id,
            senderId: sender.id,
            attemptAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'sent'
          });
          console.log('sent to', recipient.phone);

        } catch (err) {
          console.error('send err', err);
        }
      });
    }
await queue.onIdle();
    await db.collection('campaigns').doc(campaign.id).update({ status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp(), _processing: admin.firestore.FieldValue.delete() });
    console.log('Campaign completed', campaign.id);
  } catch (e) {
    console.error('processCampaign fatal', e);
  }
}

watchCampaigns().catch(err => console.error(err));
