const express = require('express');
const router = express.Router();
const User = require('../models/User');
const PhoneLink = require('../models/PhoneLink');
const { verifyToken } = require('../middleware/authMiddleware');

const normalizePhoneForLookup = value => {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10) return digits.slice(-10);
  if (digits.length < 8) return '';
  return digits;
};

const normalizeFullPhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return value?.startsWith('+') ? `+${digits}` : digits;
};

const generateSearchTerms = userData => {
  const terms = [];
  if (userData.username) {
    terms.push(String(userData.username).toLowerCase());
  }
  if (userData.displayName) {
    terms.push(...String(userData.displayName).toLowerCase().split(' ').filter(Boolean));
  }
  if (userData.mobileNormalized) {
    terms.push(String(userData.mobileNormalized));
  }
  if (userData.mobile) {
    terms.push(String(userData.mobile));
  }
  return [...new Set(terms.filter(Boolean))];
};

const syncPhoneLinks = async (userId, nextFullPhone, prevNormalized = '') => {
  const nextNormalized = normalizePhoneForLookup(nextFullPhone);
  const now = new Date();

  if (prevNormalized && prevNormalized !== nextNormalized) {
    await PhoneLink.updateMany(
      { userId: String(userId), phoneNormalized: prevNormalized, isCurrent: true },
      { $set: { isCurrent: false, validTo: now } },
    );
  }

  if (!nextNormalized) {
    return '';
  }

  const existing = await PhoneLink.findOne({
    userId: String(userId),
    phoneNormalized: nextNormalized,
    isCurrent: true,
  });

  if (!existing) {
    await PhoneLink.create({
      userId: String(userId),
      phoneNormalized: nextNormalized,
      fullPhone: normalizeFullPhone(nextFullPhone),
      isCurrent: true,
      validFrom: now,
      validTo: null,
    });
  }

  return nextNormalized;
};

router.post('/sync-profile', verifyToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const {
      username,
      displayName,
      mobile,
      email,
      photoURL,
      fcmToken,
      searchableTerms,
      privacy,
    } = req.body || {};

    let user = await User.findOne({ firebaseUid });

    const incomingUsername = String(username || '').trim().toLowerCase();
    if (incomingUsername) {
      if (!/^[a-zA-Z0-9._-]+$/.test(incomingUsername)) {
        return res.status(400).json({
          success: false,
          message: 'Username can only contain letters, numbers, dots, hyphens, and underscores',
        });
      }

      const existingUser = await User.findOne({ username: incomingUsername });
      if (existingUser && existingUser.firebaseUid !== firebaseUid) {
        return res.status(400).json({ success: false, message: 'Username already taken' });
      }

      if (user?.username && String(user.username).toLowerCase() !== incomingUsername) {
        return res.status(409).json({ success: false, message: 'Username cannot be changed once set' });
      }
    }

    const prevNormalized = String(user?.mobileNormalized || '');
    const nextFullPhone = mobile ? normalizeFullPhone(mobile) : String(user?.mobile || '');
    const nextNormalized = normalizePhoneForLookup(nextFullPhone);

    const update = {
      displayName,
      mobile: nextFullPhone || undefined,
      mobileNormalized: nextNormalized || undefined,
      email,
      photoURL,
      fcmToken,
      privacy: privacy || {
        phoneNumberVisible: true,
        lastSeenVisible: true,
        profilePhotoVisible: true,
      },
      lastOnline: new Date(),
    };

    if (incomingUsername && !user?.username) {
      update.username = incomingUsername;
    }

    user = await User.findOneAndUpdate(
      { firebaseUid },
      { $set: update },
      { new: true, upsert: true }
    );

    const finalSearchableTerms = searchableTerms || generateSearchTerms(user);
    user.searchableTerms = finalSearchableTerms;
    await user.save();

    await syncPhoneLinks(firebaseUid, nextFullPhone, prevNormalized);

    return res.status(200).json({
      success: true,
      message: 'Profile synced successfully',
      user,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to sync profile', error: error.message });
  }
});

router.post('/search', verifyToken, async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim().toLowerCase();
    if (!query) {
      return res.status(400).json({ success: false, message: 'query parameter is required and must be a non-empty string' });
    }

    const users = await User.find({
      $or: [
        { searchableTerms: { $regex: query, $options: 'i' } },
        { username: { $regex: query, $options: 'i' } },
        { displayName: { $regex: query, $options: 'i' } },
      ],
    })
      .select('firebaseUid username displayName photoURL mobile email privacy')
      .limit(20)
      .lean();

    const sanitizedUsers = users.map(user => {
      const result = {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        displayName: user.displayName,
        photoURL: user.photoURL,
        email: user.email,
      };
      if (user.privacy?.phoneNumberVisible !== false) {
        result.mobile = user.mobile;
      }
      return result;
    });

    return res.status(200).json({ success: true, users: sanitizedUsers });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/update-fcm-token', verifyToken, async (req, res) => {
  try {
    const {
      fcmToken,
      platform,
      appVersion,
      deviceId,
      reason,
      errorCode,
      errorMessage,
    } = req.body || {};
    const userId = req.user?.uid;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId (from token) is required' });
    }

    const user = await User.findOne({ firebaseUid: userId });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const nextToken = String(fcmToken || '').trim();
    if (!nextToken) {
      user.fcmTokenStatus = 'error';
      user.fcmTokenLastError = String(
        errorMessage || errorCode || reason || 'token_missing',
      ).slice(0, 300);
      user.lastOnline = new Date();
      await user.save();

      return res.status(400).json({
        success: false,
        message: 'fcmToken is required',
      });
    }

    user.fcmToken = nextToken;
    user.fcmTokenUpdatedAt = new Date();
    user.fcmTokenStatus = 'ok';
    user.fcmTokenLastError = null;
    if (platform) user.fcmTokenPlatform = String(platform).slice(0, 30);
    if (deviceId) user.fcmTokenDeviceId = String(deviceId).slice(0, 120);
    if (appVersion) user.fcmTokenAppVersion = String(appVersion).slice(0, 40);
    user.lastOnline = new Date();
    user.isOnline = true;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'FCM token updated successfully',
      tokenUpdatedAt: user.fcmTokenUpdatedAt,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/token-health', verifyToken, async (req, res) => {
  try {
    const userId = req.user?.uid;
    const user = await User.findOne({ firebaseUid: userId }).select(
      'fcmToken fcmTokenUpdatedAt fcmTokenStatus fcmTokenLastError fcmTokenPlatform fcmTokenAppVersion',
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const token = String(user.fcmToken || '');
    const tokenSuffix = token ? token.slice(-8) : '';

    return res.status(200).json({
      success: true,
      health: {
        hasToken: !!token,
        tokenSuffix,
        updatedAt: user.fcmTokenUpdatedAt || null,
        status: user.fcmTokenStatus || 'unknown',
        lastError: user.fcmTokenLastError || null,
        platform: user.fcmTokenPlatform || null,
        appVersion: user.fcmTokenAppVersion || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
