const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const User = require('../models/User');
const { verifyToken } = require('../middleware/authMiddleware');

// POST /api/messages/send
router.post('/send', verifyToken, async (req, res) => {
  try {
    console.log('📨 [SEND] Message send endpoint called');

    // Get senderId from verified token (attached by middleware)
    const senderId = req.user?.uid;
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

    // Get receiver's FCM token
    console.log('🔍 [SEND] Looking up receiver:', receiverId);

    // First try: lookup by firebaseUid
    let receiver = await User.findOne({ firebaseUid: receiverId });

    // Second try: if not found, lookup by MongoDB _id (fallback)
    if (!receiver && receiverId) {
      console.log('🔍 [SEND] FirebaseUid lookup failed, trying MongoDB ID lookup:', receiverId);
      try {
        receiver = await User.findOne({ _id: receiverId });
      } catch (e) {
        console.log('🔍 [SEND] MongoDB ID lookup also failed');
      }
    }

    // Third try: if still not found, lookup by phone number (final fallback)
    if (!receiver && receiverId) {
      console.log('🔍 [SEND] ID lookup failed, trying phone lookup:', receiverId);
      receiver = await User.findOne({
        mobile: { $regex: `${receiverId.replace(/\D/g, '')}$` }
      });
    }

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
          senderName,
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
    console.error('❌ [SEND] Message send error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/messages/delivery-receipt
// Client calls this to acknowledge delivered/read states.
router.post('/delivery-receipt', verifyToken, async (req, res) => {
  try {
    const { messageId, status } = req.body || {};

    if (!messageId || !status) {
      return res.status(400).json({
        success: false,
        message: 'messageId and status are required',
      });
    }

    const validStatuses = ['pending', 'sent', 'delivered', 'read', 'failed'];
    if (!validStatuses.includes(String(status))) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    // Current backend keeps message state on client side; this endpoint is
    // intentionally lightweight for compatibility and analytics/logging.
    console.log('📦 [RECEIPT] Delivery receipt', {
      messageId: String(messageId),
      status: String(status),
      by: req.user?.uid || 'unknown',
    });

    return res.status(200).json({
      success: true,
      message: 'Delivery receipt recorded',
    });
  } catch (error) {
    console.error('❌ [RECEIPT] Delivery receipt error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
