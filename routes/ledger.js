const express = require('express');
const router = express.Router();
const admin = require('../config/firebase');
const User = require('../models/User');
const { verifyToken } = require('../middleware/authMiddleware');

const normalizeOp = (value) => {
  return value === 'delete' || value === 'update' ? value : 'create';
};

const normalizeEntryType = (value) => {
  return value === 'get' ? 'get' : 'paid';
};

const normalizeAmount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.abs(parsed);
};

const isMongoObjectId = value => /^[a-f\\d]{24}$/i.test(String(value || ''));

// POST /api/ledger/sync
router.post('/sync', verifyToken, async (req, res) => {
  try {
    const sourceUserId = req.user?.uid;
    const {
      peerUserId,
      op,
      originTxnId,
      amount,
      note,
      timestamp,
      idempotencyKey,
      version,
      type,
      entryType,
      contactRecordId,
    } = req.body || {};

    if (!sourceUserId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized user',
      });
    }

    if (!peerUserId || !originTxnId) {
      return res.status(400).json({
        success: false,
        message: 'peerUserId and originTxnId are required',
      });
    }

    const opValue = normalizeOp(op);
    const entryTypeValue = normalizeEntryType(entryType || type);
    const amountValue = normalizeAmount(amount);

    if (opValue === 'create' && amountValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount must be greater than 0 for create operation',
      });
    }

    const receiverLookup = [{ firebaseUid: String(peerUserId) }];
    if (isMongoObjectId(peerUserId)) {
      receiverLookup.push({ _id: String(peerUserId) });
    }
    const receiver = await User.findOne({ $or: receiverLookup }).lean();
    if (!receiver) {
      return res.status(404).json({
        success: false,
        message: 'Receiver not found',
      });
    }

    const sender = await User.findOne({ firebaseUid: String(sourceUserId) })
      .select('displayName')
      .lean();

    if (!receiver.fcmToken) {
      return res.status(200).json({
        success: true,
        queued: true,
        message: 'Receiver has no FCM token',
      });
    }

    const eventData = {
      type: 'ledger_event',
      op: String(opValue),
      originTxnId: String(originTxnId),
      sourceUserId: String(sourceUserId),
      sourceUserName: String(sender?.displayName || 'Contact'),
      peerUserId: String(peerUserId),
      entryType: String(entryTypeValue),
      amount: String(amountValue),
      note: String(note || ''),
      timestamp: String(Number(timestamp || Date.now())),
      idempotencyKey: String(
        idempotencyKey || `ledger:${String(sourceUserId)}:${String(originTxnId)}:${String(opValue)}`
      ),
      version: String(Number(version || 1)),
      contactRecordId: String(contactRecordId || ''),
    };

    const senderTitle = String(sender?.displayName || 'Contact');
    const amountLabel = 'Rs ' + Number(amountValue).toLocaleString('en-IN');
    const noteText = String(note || '').trim();
    const bodyText = noteText
      ? `${senderTitle} recorded ${amountLabel} (${entryTypeValue}) - ${noteText}`
      : `${senderTitle} recorded ${amountLabel} (${entryTypeValue})`;

    await admin.messaging().send({
      token: receiver.fcmToken,
      data: eventData,
      notification: {
        title: senderTitle,
        body: bodyText,
      },
      android: {
        priority: 'high',
      },
    });

    return res.status(200).json({
      success: true,
      delivered: true,
    });
  } catch (error) {
    console.error('Ledger sync error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
