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

const normalizeEditHistoryJson = (value) => {
  const rawList = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
    ? (() => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          return [];
        }
      })()
    : [];

  const cleaned = rawList
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item >= 0)
    .slice(-10);

  return cleaned.length > 0 ? JSON.stringify(cleaned) : '';
};

const isMongoObjectId = value => /^[a-f\\d]{24}$/i.test(String(value || ''));
const INVALID_FCM_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'registration-token-not-registered',
  'invalid-registration-token',
]);

const isInvalidFcmTokenError = error => {
  const code = String(error?.code || '').trim().toLowerCase();
  return INVALID_FCM_ERROR_CODES.has(code);
};

const markUserAsUninstalled = async (userId, error) => {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId) {
    return;
  }

  try {
    await User.updateOne(
      { firebaseUid: targetUserId },
      {
        $set: {
          appInstallState: 'uninstalled',
          fcmToken: null,
          fcmTokenStatus: 'error',
          fcmTokenLastError: String(error?.code || error?.message || 'invalid_fcm_token').slice(0, 300),
        },
      },
    );
  } catch (updateError) {
    console.error('[LEDGER][FCM_STATE] Failed to mark user as uninstalled:', updateError.message);
  }
};

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
      editHistory,
      editHistoryJson,
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
    const normalizedEditHistoryJson = normalizeEditHistoryJson(
      editHistoryJson || editHistory
    );

    if (opValue === 'create' && amountValue <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount must be greater than 0 for create operation',
      });
    }

    // Step 1: Try username lookup first (new approach)
    let receiver = await User.findOne({ username: peerUserId.toLowerCase() }).lean();

    // Step 2: Fallback to firebaseUid (for legacy queued events)
    if (!receiver) {
      console.log('🔍 [LEDGER] Username lookup failed, trying firebaseUid:', peerUserId);
      receiver = await User.findOne({ firebaseUid: String(peerUserId) }).lean();
    }

    // Step 3: Fallback to MongoDB _id (if valid ObjectID)
    if (!receiver && isMongoObjectId(peerUserId)) {
      console.log('🔍 [LEDGER] FirebaseUid lookup failed, trying MongoDB ID:', peerUserId);
      try {
        receiver = await User.findOne({ _id: String(peerUserId) }).lean();
      } catch (e) {
        console.log('🔍 [LEDGER] MongoDB ID lookup also failed');
      }
    }

    if (!receiver) {
      console.error('❌ [LEDGER] Receiver not found:', peerUserId);
      return res.status(404).json({
        success: false,
        message: 'Receiver not found',
      });
    }

    const sender = await User.findOne({ firebaseUid: String(sourceUserId) })
      .select('displayName username mobile mobileNormalized')
      .lean();

    if (!receiver.fcmToken) {
      return res.status(200).json({
        success: true,
        queued: true,
        message: 'Receiver has no FCM token',
      });
    }

    const senderTitle = String(sender?.displayName || sender?.username || 'Contact');
    const sourceUserPhone = String(
      sender?.mobileNormalized || sender?.mobile || ''
    ).trim();

    const eventData = {
      type: 'ledger_event',
      op: String(opValue),
      originTxnId: String(originTxnId),
      sourceUserId: String(sourceUserId),
      sourceUserName: senderTitle,
      sourceUserPhone,
      peerUserId: String(peerUserId),
      entryType: String(entryTypeValue),
      amount: String(amountValue),
      note: String(note || ''),
      editHistory: String(normalizedEditHistoryJson || ''),
      editHistoryJson: String(normalizedEditHistoryJson || ''),
      timestamp: String(Number(timestamp || Date.now())),
      idempotencyKey: String(
        idempotencyKey || `ledger:${String(sourceUserId)}:${String(originTxnId)}:${String(opValue)}`
      ),
      version: String(Number(version || 1)),
      contactRecordId: String(contactRecordId || ''),
    };

    const amountLabel = 'Rs ' + Number(amountValue).toLocaleString('en-IN');
    const noteText = String(note || '').trim();
    const bodyText = noteText
      ? `${senderTitle} recorded ${amountLabel} (${entryTypeValue}) - ${noteText}`
      : `${senderTitle} recorded ${amountLabel} (${entryTypeValue})`;

    try {
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
    } catch (pushError) {
      if (isInvalidFcmTokenError(pushError)) {
        await markUserAsUninstalled(receiver.firebaseUid, pushError);
      }
      throw pushError;
    }

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
