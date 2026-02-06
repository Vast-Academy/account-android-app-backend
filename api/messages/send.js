const admin = require('firebase-admin');
const mongoose = require('mongoose');

// Initialize Firebase and MongoDB if not already done
let isInitialized = false;

const initialize = async () => {
  if (isInitialized) return;

  // Initialize Firebase if not already initialized
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  // Connect to MongoDB if not connected
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  isInitialized = true;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initialize();

    const { conversationId, senderId, receiverId, messageText } = req.body;

    // Validate required fields
    if (!conversationId || !senderId || !receiverId || !messageText) {
      return res.status(400).json({
        success: false,
        message: 'conversationId, senderId, receiverId, and messageText are required'
      });
    }

    // Get User model
    const User = mongoose.model('User');

    // Get receiver's FCM token
    const receiver = await User.findOne({ firebaseUid: receiverId });

    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Receiver not found'
      });
    }

    if (!receiver.fcmToken) {
      // Receiver doesn't have FCM token yet, just return success
      // Message will be stored locally on receiver's device when they open app
      return res.status(200).json({
        success: true,
        messageId: Date.now().toString(),
        note: 'FCM token not available, message will sync when receiver opens app'
      });
    }

    // Send FCM push notification
    try {
      await admin.messaging().send({
        token: receiver.fcmToken,
        data: {
          type: 'chat_message',
          conversationId,
          senderId,
          messageText,
          timestamp: Date.now().toString()
        },
        notification: {
          title: (await User.findOne({ firebaseUid: senderId }))?.displayName || 'New Message',
          body: messageText.substring(0, 100) // Limit to 100 chars
        }
      });
    } catch (fcmError) {
      console.error('FCM send error:', fcmError);
      // Don't fail if FCM fails, message is still stored locally
      return res.status(200).json({
        success: true,
        messageId: Date.now().toString(),
        note: 'Message queued, FCM delivery failed'
      });
    }

    return res.status(200).json({
      success: true,
      messageId: Date.now().toString()
    });

  } catch (error) {
    console.error('Message send error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
