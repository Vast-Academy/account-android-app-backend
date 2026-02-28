const express = require('express');
const router = express.Router();
const admin = require('../config/firebase');
const User = require('../models/User');
const MessageDelivery = require('../models/MessageDelivery');
const { verifyToken } = require('../middleware/authMiddleware');

const STATUS_ORDER = {
  accepted: 1,
  pushed: 2,
  delivered: 3,
  read: 4,
  failed: 0,
};

const DELIVERY_TTL_DAYS = 14;
const PENDING_TTL_HOURS = 24;
const DELIVERED_TTL_MINUTES = 2;

const nextExpiryDate = () => {
  const now = new Date();
  now.setDate(now.getDate() + DELIVERY_TTL_DAYS);
  return now;
};

const expiryForStatus = status => {
  const normalized = String(status || '').toLowerCase();
  const now = Date.now();
  if (normalized === 'delivered' || normalized === 'read') {
    return new Date(now + DELIVERED_TTL_MINUTES * 60 * 1000);
  }
  if (
    normalized === 'accepted' ||
    normalized === 'pushed' ||
    normalized === 'failed'
  ) {
    return new Date(now + PENDING_TTL_HOURS * 60 * 60 * 1000);
  }
  return nextExpiryDate();
};

const shouldAdvanceStatus = (currentStatus, nextStatus) => {
  const currentRank = STATUS_ORDER[String(currentStatus || '')] ?? 0;
  const nextRank = STATUS_ORDER[String(nextStatus || '')] ?? 0;
  return nextRank >= currentRank;
};

const resolveUserByReceiverId = async receiverId => {
  const target = String(receiverId || '').trim();
  if (!target) {
    return null;
  }

  let receiver = await User.findOne({firebaseUid: target});
  if (receiver) {
    return receiver;
  }

  try {
    receiver = await User.findOne({_id: target});
    if (receiver) {
      return receiver;
    }
  } catch {
    // Ignore invalid object id.
  }

  const digits = target.replace(/\D/g, '');
  if (digits) {
    receiver = await User.findOne({
      mobile: {$regex: `${digits}$`},
    });
  }

  return receiver;
};

const saveDeliveryState = async params => {
  const {
    messageId,
    conversationId,
    senderId,
    receiverId,
    messageText,
    messageTimestamp = 0,
    status,
    lastError = null,
  } = params;

  const now = new Date();
  const update = {
    conversationId: String(conversationId || ''),
    senderId: String(senderId || ''),
    receiverId: String(receiverId || ''),
    messageText: String(messageText || ''),
    messageTimestamp: Number(messageTimestamp || 0),
    expiresAt: expiryForStatus(status),
    updatedAt: now,
  };

  if (status) {
    update.status = String(status);
  }

  if (lastError !== null) {
    update.lastError = String(lastError || '');
    update.retryCount = 1;
  } else {
    update.lastError = null;
  }

  await MessageDelivery.findOneAndUpdate(
    {messageId: String(messageId)},
    {
      $set: update,
      $setOnInsert: {
        messageId: String(messageId),
        createdAt: now,
      },
    },
    {
      upsert: true,
      new: true,
    }
  );
};

// POST /api/messages/send
router.post('/send', verifyToken, async (req, res) => {
  try {
    const senderId = String(req.user?.uid || '').trim();
    const {
      conversationId,
      receiverId,
      messageText,
      messageId: incomingMessageId,
      messageType = 'text',
      timestamp,
    } = req.body || {};

    const trimmedConversationId = String(conversationId || '').trim();
    const trimmedReceiverId = String(receiverId || '').trim();
    const trimmedMessageText = String(messageText || '').trim();
    const messageId =
      String(incomingMessageId || '').trim() ||
      `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const payloadTimestamp = Number(timestamp || Date.now());

    if (!trimmedConversationId || !senderId || !trimmedReceiverId || !trimmedMessageText) {
      return res.status(400).json({
        success: false,
        message: 'conversationId, receiverId, and messageText are required',
      });
    }

    if (senderId === trimmedReceiverId) {
      return res.status(400).json({
        success: false,
        message: 'senderId and receiverId cannot be the same',
      });
    }

    const receiver = await resolveUserByReceiverId(trimmedReceiverId);
    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Receiver not found',
      });
    }

    const receiverUid = String(receiver.firebaseUid || receiver._id || '').trim();
    if (!receiverUid) {
      return res.status(404).json({
        success: false,
        message: 'Receiver UID not found',
      });
    }

    // Persist acceptance before push attempt.
    await saveDeliveryState({
      messageId,
      conversationId: trimmedConversationId,
      senderId,
      receiverId: receiverUid,
      messageText: trimmedMessageText,
      messageTimestamp: payloadTimestamp,
      status: 'accepted',
    });

    const senderUser = await User.findOne({firebaseUid: senderId});
    const senderName = senderUser?.displayName || senderUser?.username || 'New Message';
    const senderPhone = String(
      senderUser?.mobileNormalized || senderUser?.mobile || ''
    ).trim();

    if (!receiver.fcmToken) {
      return res.status(200).json({
        success: true,
        messageId,
        status: 'accepted',
        queued: true,
        note: 'Receiver FCM token missing',
      });
    }

    try {
      await admin.messaging().send({
        token: receiver.fcmToken,
        data: {
          type: 'chat_message',
          messageId,
          conversationId: trimmedConversationId,
          senderId,
          senderName,
          senderPhone,
          messageText: trimmedMessageText,
          messageType: String(messageType || 'text'),
          timestamp: String(payloadTimestamp),
        },
        notification: {
          title: senderName,
          body: trimmedMessageText.slice(0, 100),
        },
        android: {
          priority: 'high',
        },
      });

      await saveDeliveryState({
        messageId,
        conversationId: trimmedConversationId,
        senderId,
        receiverId: receiverUid,
        messageText: trimmedMessageText,
        messageTimestamp: payloadTimestamp,
        status: 'pushed',
      });

      return res.status(200).json({
        success: true,
        messageId,
        status: 'pushed',
      });
    } catch (fcmError) {
      await saveDeliveryState({
        messageId,
        conversationId: trimmedConversationId,
        senderId,
        receiverId: receiverUid,
        messageText: trimmedMessageText,
        messageTimestamp: payloadTimestamp,
        status: 'accepted',
        lastError: fcmError?.message || 'FCM send failed',
      });

      return res.status(200).json({
        success: true,
        messageId,
        status: 'accepted',
        queued: true,
        note: 'FCM delivery failed, retained for retry',
      });
    }
  } catch (error) {
    console.error('[SEND] Message send error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/messages/delivery-receipt
router.post('/delivery-receipt', verifyToken, async (req, res) => {
  try {
    const receiptBy = String(req.user?.uid || '').trim();
    const {messageId, status} = req.body || {};

    if (!messageId || !status) {
      return res.status(400).json({
        success: false,
        message: 'messageId and status are required',
      });
    }

    const normalizedStatus = String(status || '').trim();
    const validStatuses = ['delivered', 'read'];
    if (!validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const delivery = await MessageDelivery.findOne({messageId: String(messageId).trim()});
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Message delivery record not found',
      });
    }

    if (String(delivery.receiverId || '').trim() !== receiptBy) {
      return res.status(403).json({
        success: false,
        message: 'Only receiver can send delivery receipt for this message',
      });
    }

    if (shouldAdvanceStatus(delivery.status, normalizedStatus)) {
      delivery.status = normalizedStatus;
    }
    delivery.lastError = null;
    if (normalizedStatus === 'delivered' && !delivery.deliveredAt) {
      delivery.deliveredAt = new Date();
    }
    if (normalizedStatus === 'read' && !delivery.readAt) {
      delivery.readAt = new Date();
      if (!delivery.deliveredAt) {
        delivery.deliveredAt = new Date();
      }
    }
    delivery.expiresAt = expiryForStatus(normalizedStatus);
    await delivery.save();

    const sender = await User.findOne({firebaseUid: String(delivery.senderId || '').trim()});
    if (sender?.fcmToken) {
      try {
        await admin.messaging().send({
          token: sender.fcmToken,
          data: {
            type: 'delivery_receipt',
            messageId: String(delivery.messageId || ''),
            status: String(delivery.status || normalizedStatus),
            conversationId: String(delivery.conversationId || ''),
            timestamp: String(Date.now()),
          },
          android: {
            priority: 'high',
          },
        });
      } catch (relayError) {
        console.error('[RECEIPT] Failed to relay receipt to sender:', relayError.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery receipt recorded',
      status: delivery.status,
    });
  } catch (error) {
    console.error('[RECEIPT] Delivery receipt error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/messages/pending-sync
router.get('/pending-sync', verifyToken, async (req, res) => {
  try {
    const uid = String(req.user?.uid || '').trim();
    const conversationId = String(req.query?.conversationId || '').trim();
    const sinceTimestamp = Number.parseInt(String(req.query?.sinceTimestamp || '0'), 10) || 0;
    const limitRaw = Number.parseInt(String(req.query?.limit || '100'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized user',
      });
    }
    if (!conversationId) {
      return res.status(400).json({
        success: false,
        message: 'conversationId is required',
      });
    }

    const participants = conversationId.split('_').filter(Boolean);
    if (!participants.includes(uid)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied for conversation',
      });
    }

    const rows = await MessageDelivery.find({
      conversationId,
      receiverId: uid,
      status: {$in: ['accepted', 'pushed', 'delivered', 'read']},
      messageTimestamp: {$gt: sinceTimestamp},
    })
      .sort({messageTimestamp: 1, createdAt: 1})
      .limit(limit)
      .lean();

    const messages = rows.map(row => ({
      messageId: String(row.messageId || ''),
      conversationId: String(row.conversationId || ''),
      senderId: String(row.senderId || ''),
      receiverId: String(row.receiverId || ''),
      messageText: String(row.messageText || ''),
      messageType: 'text',
      timestamp: Number(row.messageTimestamp || 0) || new Date(row.createdAt || Date.now()).getTime(),
      status: String(row.status || 'accepted'),
    }));

    return res.status(200).json({
      success: true,
      messages,
      count: messages.length,
      conversationId,
      sinceTimestamp,
    });
  } catch (error) {
    console.error('[PENDING_SYNC] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
