const admin = require('../config/firebase');
const User = require('../models/User');
const {
  isInvalidFcmTokenError,
  markTokenAuditResult,
  markUserAsUninstalled,
} = require('./fcmTokenState');

const AUDIT_STALE_AFTER_HOURS = Math.max(
  24,
  Number(process.env.FCM_AUDIT_STALE_AFTER_HOURS || 72) || 72,
);
const AUDIT_MIN_INTERVAL_HOURS = Math.max(
  24,
  Number(process.env.FCM_AUDIT_MIN_INTERVAL_HOURS || 72) || 72,
);
const AUDIT_BATCH_SIZE = Math.max(
  1,
  Math.min(500, Number(process.env.FCM_AUDIT_BATCH_SIZE || 100) || 100),
);
const AUDIT_TTL_SECONDS = Math.max(
  60,
  Math.min(86400, Number(process.env.FCM_AUDIT_TTL_SECONDS || 3600) || 3600),
);

const getTokenSeenAt = user => {
  if (user?.lastTokenSeenAt) {
    return new Date(user.lastTokenSeenAt);
  }
  if (user?.fcmTokenUpdatedAt) {
    return new Date(user.fcmTokenUpdatedAt);
  }
  if (user?.lastLogin) {
    return new Date(user.lastLogin);
  }
  return new Date(0);
};

const buildAuditPayload = ({ user, tokenSeenAt, auditedAt }) => ({
  token: user.fcmToken,
  data: {
    type: 'fcm_token_audit',
    auditAt: String(auditedAt.getTime()),
    tokenSeenAt: String(tokenSeenAt.getTime()),
  },
  android: {
    priority: 'normal',
    ttl: AUDIT_TTL_SECONDS * 1000,
  },
});

const shouldAuditUser = (user, now) => {
  const staleSeenThreshold = now.getTime() - AUDIT_STALE_AFTER_HOURS * 60 * 60 * 1000;
  const recentAuditThreshold = now.getTime() - AUDIT_MIN_INTERVAL_HOURS * 60 * 60 * 1000;
  const seenAt = getTokenSeenAt(user).getTime();
  const lastAuditAt = user?.lastAuditAt ? new Date(user.lastAuditAt).getTime() : 0;

  if (seenAt > staleSeenThreshold) {
    return false;
  }
  if (lastAuditAt && lastAuditAt > recentAuditThreshold) {
    return false;
  }
  return true;
};

const selectAuditCandidates = async (batchSize = AUDIT_BATCH_SIZE) => {
  const now = new Date();
  const staleSeenDate = new Date(now.getTime() - AUDIT_STALE_AFTER_HOURS * 60 * 60 * 1000);
  const recentAuditDate = new Date(now.getTime() - AUDIT_MIN_INTERVAL_HOURS * 60 * 60 * 1000);
  const users = await User.find({
    fcmToken: { $type: 'string', $ne: '' },
    appInstallState: { $ne: 'uninstalled' },
    $and: [
      {
        $or: [
          { lastTokenSeenAt: { $lte: staleSeenDate } },
          { lastTokenSeenAt: null, fcmTokenUpdatedAt: { $lte: staleSeenDate } },
          { lastTokenSeenAt: null, fcmTokenUpdatedAt: null },
        ],
      },
      {
        $or: [
          { lastAuditAt: null },
          { lastAuditAt: { $lte: recentAuditDate } },
        ],
      },
    ],
  })
    .select('firebaseUid fcmToken lastTokenSeenAt fcmTokenUpdatedAt lastAuditAt lastLogin')
    .sort({ lastAuditAt: 1, lastTokenSeenAt: 1, fcmTokenUpdatedAt: 1 })
    .limit(batchSize)
    .lean();

  return users.filter(user => shouldAuditUser(user, now)).slice(0, batchSize);
};

const runFcmTokenAudit = async (options = {}) => {
  const {
    batchSize = AUDIT_BATCH_SIZE,
    reason = 'manual',
  } = options;

  const auditedAt = new Date();
  const candidates = await selectAuditCandidates(batchSize);
  const summary = {
    reason,
    batchSize,
    selected: candidates.length,
    valid: 0,
    uninstalled: 0,
    sendErrors: 0,
    skipped: 0,
  };

  for (const candidate of candidates) {
    const userId = String(candidate?.firebaseUid || '').trim();
    const token = String(candidate?.fcmToken || '').trim();
    if (!userId || !token) {
      summary.skipped += 1;
      continue;
    }

    try {
      await admin.messaging().send(
        buildAuditPayload({
          user: candidate,
          tokenSeenAt: getTokenSeenAt(candidate),
          auditedAt,
        }),
      );
      await markTokenAuditResult(userId, {
        auditedAt,
        result: 'valid',
      });
      summary.valid += 1;
    } catch (error) {
      if (isInvalidFcmTokenError(error)) {
        await markUserAsUninstalled(userId, error, {
          auditedAt,
          auditResult: 'invalid_token',
        });
        summary.uninstalled += 1;
      } else {
        await markTokenAuditResult(userId, {
          auditedAt,
          result: `send_error:${String(error?.code || 'unknown').slice(0, 40)}`,
          error: error?.message || 'audit_send_failed',
        });
        summary.sendErrors += 1;
      }
    }
  }

  console.log('[FCM_AUDIT] Completed token audit', summary);
  return summary;
};

module.exports = {
  runFcmTokenAudit,
  selectAuditCandidates,
};
