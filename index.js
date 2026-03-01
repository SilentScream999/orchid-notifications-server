const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
const messaging = admin.messaging();

async function startListening() {
  console.log('👂 Listening for new messages...');

  db.collectionGroup('messages').onSnapshot(async (snapshot) => {
    const newDocs = snapshot.docChanges().filter(c => c.type === 'added');

    for (const change of newDocs) {
      try {
        const data = change.doc.data();
        const path = change.doc.ref.path;
        const parts = path.split('/');
        const recipientUid = parts[1];
        const senderUid = parts[3];

        if (data.sender === recipientUid) continue;

        const senderSnap = await db.doc(`usernames/${senderUid}`).get();
        const senderName = senderSnap.exists
          ? (senderSnap.data()?.username ?? 'Someone')
          : 'Someone';

        const recipientSnap = await db
          .doc(`accounts/${recipientUid}/profile/info`)
          .get();
        const fcmToken = recipientSnap.data()?.fcmToken;
        if (!fcmToken) continue;

        await messaging.send({
          token: fcmToken,
          // No notification field — data-only so Android routes to our service
          data: {
            senderUid,
            senderName,
            recipientUid,
            encryptedText: data.encryptedText ?? '',
            iv: data.iv ?? '',
          },
          android: {
            priority: 'high',
          },
        });

        console.log(`✅ Notified ${recipientUid} about message from ${senderName}`);
      } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered') {
          const parts = change.doc.ref.path.split('/');
          const recipientUid = parts[1];
          await db.doc(`accounts/${recipientUid}/profile/info`)
            .update({ fcmToken: admin.firestore.FieldValue.delete() });
        } else {
          console.error('Failed to send notification:', e);
        }
      }
    }
  }, err => console.error('Snapshot error:', err));
}

app.get('/', (req, res) => res.send('Orchid notification server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  startListening();
});
