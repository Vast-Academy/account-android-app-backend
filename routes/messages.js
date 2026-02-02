const express = require('express');
const router = express.Router();
const User = require('../models/User');
const admin = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');

// 1. Send Message (relay via FCM)
router.post('/send', verifyToken, async (req, res) => {
  try {
    const senderId = req.user.uid;
    const { receiverId, messageId, messageText, messageType, timestamp } = req.body;

    // Validation
    if (!receiverId || !messageId || !messageText) {
      return res.status(400).json({
        success: false,
        message: 'receiverId, messageId, and messageText are required'
      });
    }

    // Get sender details
    const sender = await User.findOne({ firebaseUid: senderId }).select('displayName username photoURL').lean();

    if (!sender) {
      return res.status(404).json({
        success: false,
        message: 'Sender not found'
      });
    }

    // Get receiver details and FCM token
    const receiver = await User.findOne({ firebaseUid: receiverId }).select('fcmToken displayName').lean();

    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Receiver not found'
      });
    }

    if (!receiver.fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'Receiver is not registered for notifications'
      });
    }

    // Prepare FCM message
    const fcmMessage = {
      token: receiver.fcmToken,
      data: {
        type: 'chat_message',
        messageId,
        conversationId: `${senderId}_${receiverId}`,
        senderId,
        senderName: sender.displayName,
        messageText: messageText.substring(0, 100), // Limit preview
        messageType: messageType || 'text',
        timestamp: timestamp.toString()
      },
      notification: {
        title: sender.displayName,
        body: messageText.substring(0, 100)
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'chat_messages'
        }
      },
      apns: {
        headers: {
          'apns-priority': '10'
        }
      }
    };

    // Send FCM push
    await admin.messaging().send(fcmMessage);

    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      messageId
    });
  } catch (error) {
    console.error('Send Message Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// 2. Record Delivery Receipt
router.post('/delivery-receipt', verifyToken, async (req, res) => {
  try {
    const { messageId, status } = req.body;

    if (!messageId || !status) {
      return res.status(400).json({
        success: false,
        message: 'messageId and status are required'
      });
    }

    // Validate status
    const validStatuses = ['pending', 'sent', 'delivered', 'read', 'failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Note: Delivery receipts are typically managed on the client side locally
    // This endpoint is for logging/analytics purposes
    console.log(`Delivery receipt: Message ${messageId} - Status: ${status}`);

    return res.status(200).json({
      success: true,
      message: 'Delivery receipt recorded'
    });
  } catch (error) {
    console.error('Delivery Receipt Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to record delivery receipt',
      error: error.message
    });
  }
});

module.exports = router;
