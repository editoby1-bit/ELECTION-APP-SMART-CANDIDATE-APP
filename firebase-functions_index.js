const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

exports.createCampaign = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Request not authenticated');
  }
  const campaign = {
    name: data.name,
    messageTemplate: data.messageTemplate,
    targetQuery: data.targetQuery || {},
    status: 'scheduled',
    createdBy: context.auth.uid,
    scheduledAt: admin.firestore.Timestamp.now()
  };
  const ref = await db.collection('campaigns').add(campaign);
  return { id: ref.id };
});
