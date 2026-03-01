const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Initialize Firebase Admin with your service account
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Listen for new messages via Firestore snapshot
async function startListening() {
  console.log('👂 Listening for new messages...');

  db.collectionGroup('messages').onSnapshot(async (snapshot) => {
    const newDocs = snapshot.docChanges().filter(c => c.type === 'added');

    for (const change of newDocs) {
      try {
        const data = change.doc.data();
        const path = change.doc.ref.path;
        // path: accounts/{recipientUid}/dms/{senderUid}/messages/{messageId}
        const parts = path.split('/');
        const recipientUid = parts[1];
        const senderUid = parts[3];

        // Don't notify yourself
        if (data.sender === recipientUid) continue;

        // Get sender's display name
        const senderSnap = await db.doc(`usernames/${senderUid}`).get();
        const senderName = senderSnap.exists
          ? (senderSnap.data()?.username ?? 'Someone')
          : 'Someone';

        // Get recipient's FCM token
        const recipientSnap = await db
          .doc(`accounts/${recipientUid}/profile/info`)
          .get();
        const fcmToken = recipientSnap.data()?.fcmToken;
        if (!fcmToken) continue;

        await messaging.send({
          token: fcmToken,
          notification: {
            title: senderName,
            body: '📨 Sent you a message',
          },
          data: { senderUid, recipientUid },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'orchid_messages',
            },
          },
        });

        console.log(`✅ Notified ${recipientUid} about message from ${senderName}`);
      } catch (e) {
        // Stale token — clean it up
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

// Health check endpoint (Render needs this)
app.get('/', (req, res) => res.send('Orchid notification server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  startListening();
});