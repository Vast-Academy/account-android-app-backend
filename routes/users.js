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
    const { fcmToken } = req.body || {};
    const userId = req.user?.uid;

    if (!userId || !fcmToken) {
      return res.status(400).json({ success: false, message: 'userId (from token) and fcmToken are required' });
    }

    const user = await User.findOne({ firebaseUid: userId });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.fcmToken = fcmToken;
    user.lastOnline = new Date();
    user.isOnline = true;
    await user.save();

    return res.status(200).json({ success: true, message: 'FCM token updated successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
