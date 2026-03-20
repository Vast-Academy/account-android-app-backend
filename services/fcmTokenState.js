const User = require('../models/User');

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

  const nextSet = {
    appInstallState: 'uninstalled',
    fcmToken: null,
    fcmTokenStatus: 'error',
    fcmTokenLastError: String(error?.code || error?.message || 'invalid_fcm_token').slice(0, 300),
  };

  if (auditedAt) {
    nextSet.lastAuditAt = auditedAt instanceof Date ? auditedAt : new Date(auditedAt);
  }
  if (auditResult) {
    nextSet.lastAuditResult = String(auditResult).slice(0, 80);
  }

  try {
    await User.updateOne(
      { firebaseUid: targetUserId },
      {
        $set: nextSet,
      },
    );
  } catch (updateError) {
    console.error('[FCM_STATE] Failed to mark user as uninstalled:', updateError.message);
  }
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
  isInvalidFcmTokenError,
  applyInstalledTokenState,
  markUserAsUninstalled,
  markTokenAuditResult,
};
