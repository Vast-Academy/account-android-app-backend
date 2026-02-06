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

const verifyToken = async (req) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    throw new Error('No authorization token');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return decodedToken.uid;
  } catch (error) {
    throw new Error('Invalid token');
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initialize();
    console.log('📨 [SEND] Message send endpoint called');

    // Verify authentication token
    const senderId = await verifyToken(req);
    console.log('✅ [SEND] Token verified, sender:', senderId);

    const { conversationId, receiverId, messageText } = req.body;
    console.log('📤 [SEND] Payload:', { conversationId, receiverId, messageTextLength: messageText?.length });

    // Validate required fields
    if (!conversationId || !senderId || !receiverId || !messageText) {
      console.error('❌ [SEND] Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'conversationId, senderId, receiverId, and messageText are required'
      });
    }

    // Get User model
    const User = mongoose.model('User');

    // Get receiver's FCM token
    console.log('🔍 [SEND] Looking up receiver:', receiverId);
    const receiver = await User.findOne({ firebaseUid: receiverId });

    if (!receiver) {
      console.error('❌ [SEND] Receiver not found:', receiverId);
      return res.status(404).json({
        success: false,
        message: 'Receiver not found'
      });
    }

    console.log('✅ [SEND] Receiver found:', receiver.displayName);

    if (!receiver.fcmToken) {
      console.warn('⚠️ [SEND] Receiver has no FCM token');
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
      console.log('📤 [SEND] Sending FCM notification to:', receiver.fcmToken.substring(0, 20) + '...');
      const senderUser = await User.findOne({ firebaseUid: senderId });
      const senderName = senderUser?.displayName || 'New Message';

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
          title: senderName,
          body: messageText.substring(0, 100) // Limit to 100 chars
        }
      });

      console.log('✅ [SEND] FCM notification sent successfully');
    } catch (fcmError) {
      console.error('❌ [SEND] FCM send error:', fcmError.message);
      // Don't fail if FCM fails, message is still stored locally
      return res.status(200).json({
        success: true,
        messageId: Date.now().toString(),
        note: 'Message queued, FCM delivery failed'
      });
    }

    console.log('✅ [SEND] Message relay complete');
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
