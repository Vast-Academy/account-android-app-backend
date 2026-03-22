const User = require('../models/User');
const PhoneLink = require('../models/PhoneLink');

const INVALID_FCM_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'registration-token-not-registered',
  'invalid-registration-token',
]);

const PHONE_RECLAIM_GRACE_MINUTES = Math.max(
  1,
  Number(process.env.PHONE_RECLAIM_GRACE_MINUTES || 5) || 5,
);

const isInvalidFcmTokenError = error => {
  const code = String(error?.code || '').trim().toLowerCase();
  return INVALID_FCM_ERROR_CODES.has(code);
};

const buildSearchableTerms = user => {
  const terms = [];
  if (user?.displayName) {
    terms.push(...String(user.displayName).toLowerCase().split(' ').filter(Boolean));
  }
  if (user?.username) {
    terms.push(String(user.username).toLowerCase());
  }
  if (user?.mobileNormalized) {
    terms.push(String(user.mobileNormalized));
  }
  if (user?.mobile) {
    terms.push(String(user.mobile));
  }
  return [...new Set(terms.filter(Boolean))];
};

const getEffectivePhoneOwnershipState = user => {
  const explicit = String(user?.phoneOwnershipState || '').trim().toLowerCase();
  if (explicit === 'active' || explicit === 'reclaimable' || explicit === 'released') {
    return explicit;
  }
  return String(user?.mobileNormalized || user?.mobile || '').trim() ? 'active' : 'released';
};

const clearPhoneReclaimWindow = user => {
  user.phoneReclaimMarkedAt = null;
  user.phoneReleaseAfter = null;
  return user;
};

const applyInstalledTokenState = (user, options = {}) => {
  const {
    token,
    platform,
    deviceId,
    appVersion,
    seenAt = new Date(),
  } = options;

  const nextSeenAt = seenAt instanceof Date ? seenAt : new Date(seenAt);
  user.fcmToken = String(token || '').trim();
  user.appInstallState = 'installed';
  user.fcmTokenUpdatedAt = nextSeenAt;
  user.lastTokenSeenAt = nextSeenAt;
  user.lastAuditResult = 'token_sync';
  user.fcmTokenStatus = 'ok';
  user.fcmTokenLastError = null;
  user.phoneOwnershipState = String(user.mobileNormalized || user.mobile || '').trim()
    ? 'active'
    : 'released';
  clearPhoneReclaimWindow(user);
  if (platform) user.fcmTokenPlatform = String(platform).slice(0, 30);
  if (deviceId) user.fcmTokenDeviceId = String(deviceId).slice(0, 120);
  if (appVersion) user.fcmTokenAppVersion = String(appVersion).slice(0, 40);
  return user;
};

const markUserAsUninstalled = async (userId, error, options = {}) => {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId) {
    return;
  }

  const {
    auditedAt = null,
    auditResult = 'invalid_token',
  } = options;

  try {
    const user = await User.findOne({ firebaseUid: targetUserId });
    if (!user) {
      return;
    }

    const nextAuditAt = auditedAt instanceof Date ? auditedAt : auditedAt ? new Date(auditedAt) : new Date();
    user.appInstallState = 'uninstalled';
    user.fcmToken = null;
    user.fcmTokenStatus = 'error';
    user.fcmTokenLastError = String(
      error?.code || error?.message || 'invalid_fcm_token',
    ).slice(0, 300);
    if (auditedAt) {
      user.lastAuditAt = nextAuditAt;
    }
    if (auditResult) {
      user.lastAuditResult = String(auditResult).slice(0, 80);
    }

    const currentPhoneOwnershipState = getEffectivePhoneOwnershipState(user);
    if (String(user.mobileNormalized || '').trim() && currentPhoneOwnershipState !== 'released') {
      user.phoneOwnershipState = 'reclaimable';
      if (!user.phoneReclaimMarkedAt) {
        user.phoneReclaimMarkedAt = nextAuditAt;
      }
      user.phoneReleaseAfter =
        user.phoneReleaseAfter ||
        new Date(user.phoneReclaimMarkedAt.getTime() + PHONE_RECLAIM_GRACE_MINUTES * 60 * 1000);
    } else {
      user.phoneOwnershipState = 'released';
      clearPhoneReclaimWindow(user);
    }

    await user.save();
  } catch (updateError) {
    console.error('[FCM_STATE] Failed to mark user as uninstalled:', updateError.message);
  }
};

const releaseExpiredPhoneOwnerships = async (options = {}) => {
  const {
    normalizedPhones = [],
    now = new Date(),
    limit = 100,
  } = options;

  const targetPhones = [...new Set((Array.isArray(normalizedPhones) ? normalizedPhones : []).map(item => String(item || '').trim()).filter(Boolean))];
  const query = {
    phoneOwnershipState: 'reclaimable',
    phoneReleaseAfter: { $lte: now instanceof Date ? now : new Date(now) },
    mobileNormalized: { $type: 'string', $ne: '' },
  };

  if (targetPhones.length) {
    query.mobileNormalized = { $in: targetPhones };
  }

  const users = await User.find(query)
    .limit(Math.max(1, Number(limit || 100) || 100));

  let released = 0;
  const releasedAt = now instanceof Date ? now : new Date(now);

  for (const user of users) {
    const firebaseUid = String(user?.firebaseUid || '').trim();
    const phoneNormalized = String(user?.mobileNormalized || '').trim();
    if (!firebaseUid) {
      continue;
    }

    if (phoneNormalized) {
      await PhoneLink.updateMany(
        {
          userId: firebaseUid,
          phoneNormalized,
          isCurrent: true,
        },
        {
          $set: {
            isCurrent: false,
            validTo: releasedAt,
          },
        },
      );
    }

    user.mobile = null;
    user.mobileNormalized = null;
    user.phoneOwnershipState = 'released';
    user.setupComplete = false;
    clearPhoneReclaimWindow(user);
    user.searchableTerms = buildSearchableTerms(user);
    await user.save();
    released += 1;
  }

  return released;
};

const markTokenAuditResult = async (userId, options = {}) => {
  const targetUserId = String(userId || '').trim();
  if (!targetUserId) {
    return;
  }

  const {
    auditedAt = new Date(),
    result = 'valid',
    error = null,
  } = options;

  const nextSet = {
    lastAuditAt: auditedAt instanceof Date ? auditedAt : new Date(auditedAt),
    lastAuditResult: String(result || 'unknown').slice(0, 80),
  };

  if (String(result || '') === 'valid') {
    nextSet.fcmTokenStatus = 'ok';
    nextSet.fcmTokenLastError = null;
  }

  if (error) {
    nextSet.fcmTokenLastError = String(error).slice(0, 300);
  }

  try {
    await User.updateOne(
      { firebaseUid: targetUserId },
      {
        $set: nextSet,
      },
    );
  } catch (updateError) {
    console.error('[FCM_STATE] Failed to persist audit result:', updateError.message);
  }
};

module.exports = {
  INVALID_FCM_ERROR_CODES,
  PHONE_RECLAIM_GRACE_MINUTES,
  isInvalidFcmTokenError,
  getEffectivePhoneOwnershipState,
  applyInstalledTokenState,
  markUserAsUninstalled,
  releaseExpiredPhoneOwnerships,
  markTokenAuditResult,
};
