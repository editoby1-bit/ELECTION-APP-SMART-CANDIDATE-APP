// node scripts/import_recipients.js recipients.csv
const admin = require('firebase-admin');
const fs = require('fs');
if(!process.env.FIREBASE_SERVICE_ACCOUNT_JSON){ console.error('set FIREBASE_SERVICE_ACCOUNT_JSON'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
const db = admin.firestore();
const csv = fs.readFileSync(process.argv[2],'utf8').trim().split('\\n');
(async ()=>{
  for(let i=1;i<csv.length;i++){
    const row = csv[i].split(',');
    const doc = { phone: row[0].trim(), lga: row[1].trim(), ward: row[2].trim(), name: row[3].trim(), optedOut:false };
    await db.collection('recipients').add(doc);
    console.log('added', row[0]);
  }
  console.log('done');
  process.exit(0);
})();