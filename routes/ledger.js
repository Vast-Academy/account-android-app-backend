const express = require('express');
const router = express.Router();
const admin = require('../config/firebase');
const User = require('../models/User');
const { verifyToken } = require('../middleware/authMiddleware');
const {
  isInvalidFcmTokenError,
  markUserAsUninstalled,
} = require('../services/fcmTokenState');
const {
  getContactByDualPath,
  normalizePhoneForLookup,
} = require('../services/contactReconciliationService');

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

    // SSOT: Dual-path lookup (username → firebaseUid → phone)
    let receiver = null;

    // Step 1: Try username lookup first
    receiver = await User.findOne({ username: peerUserId.toLowerCase() }).lean();

    if (!receiver) {
      console.log('🔍 [LEDGER_SSOT] Username lookup failed:', peerUserId);

      // Step 2: Try firebaseUid
      receiver = await User.findOne({ firebaseUid: String(peerUserId) }).lean();
    }

    // Step 3: Try by normalized phone as dual-path fallback
    if (!receiver) {
      console.log('🔍 [LEDGER_SSOT] FirebaseUid lookup failed, trying dual-path lookup');
      receiver = await getContactByDualPath(peerUserId, peerUserId);
    }

    // Step 4: MongoDB _id fallback (if valid ObjectID)
    if (!receiver && isMongoObjectId(peerUserId)) {
      console.log('🔍 [LEDGER_SSOT] Trying MongoDB ID:', peerUserId);
      try {
        receiver = await User.findOne({ _id: String(peerUserId) }).lean();
      } catch (e) {
        console.log('🔍 [LEDGER_SSOT] MongoDB ID lookup failed');
      }
    }

    if (!receiver) {
      console.error('❌ [LEDGER_SSOT] Receiver not found with SSOT:', peerUserId);
      return res.status(404).json({
        success: false,
        message: 'Receiver not found',
      });
    }

    console.log('✅ [LEDGER_SSOT] Receiver found:', {
      firebaseUid: receiver.firebaseUid,
      phone: receiver.mobileNormalized,
      username: receiver.username,
    });

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

    // SSOT: Include both firebaseUid and phone for dual-path resolution
    const eventData = {
      type: 'ledger_event',
      op: String(opValue),
      originTxnId: String(originTxnId),
      sourceUserId: String(sourceUserId),
      sourceUserName: senderTitle,
      sourceUserPhone,
      peerUserId: String(receiver.firebaseUid), // Use firebaseUid as primary
      peerUserPhone: String(receiver.mobileNormalized || receiver.mobile || ''), // Add phone as secondary
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
      // SSOT tracking
      ssotResolution: 'backend_dual_path',
      receiverAppState: receiver.appInstallState,
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
