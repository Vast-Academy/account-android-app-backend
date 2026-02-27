const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const User = require('../models/User');
const PhoneLink = require('../models/PhoneLink');
const PhoneClaim = require('../models/PhoneClaim');
const admin = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');

const validateUsername = username => /^[a-zA-Z0-9._-]+$/.test(String(username || ''));

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

const generateSearchableTerms = user => {
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

  await PhoneLink.updateMany(
    { userId: String(userId), phoneNormalized: nextNormalized, isCurrent: true },
    { $set: { fullPhone: normalizeFullPhone(nextFullPhone), validTo: null } },
  );

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

const isPhoneTaken = async (normalizedPhone, excludeFirebaseUid = '') => {
  if (!normalizedPhone) return false;

  const active = await PhoneLink.findOne({
    phoneNormalized: normalizedPhone,
    isCurrent: true,
    ...(excludeFirebaseUid ? { userId: { $ne: String(excludeFirebaseUid) } } : {}),
  }).lean();

  if (active) {
    return true;
  }

  const fallback = await User.findOne({
    mobileNormalized: normalizedPhone,
    ...(excludeFirebaseUid ? { firebaseUid: { $ne: String(excludeFirebaseUid) } } : {}),
  }).lean();

  return Boolean(fallback);
};

router.post('/google-signin', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'ID token is required' });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    let user = await User.findOne({ firebaseUid: uid });

    if (!user) {
      user = new User({
        firebaseUid: uid,
        email,
        displayName: name || email.split('@')[0],
        photoURL: picture || null,
        setupComplete: false,
        googleDriveConnected: true,
      });
      await user.save();
    } else {
      user.lastLogin = Date.now();
      await user.save();
    }

    return res.status(200).json({
      success: true,
      setupComplete: user.setupComplete,
      user,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Authentication failed', error: error.message });
  }
});

router.post('/check-username', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ success: false, message: 'Invalid username format' });
    }

    const existingUser = await User.findOne({ username: String(username).toLowerCase() });
    return res.status(200).json({ success: true, available: !existingUser, suggestions: [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to check username', error: error.message });
  }
});

router.post('/complete-setup', async (req, res) => {
  try {
    const { firebaseUid, username, password } = req.body;
    if (!firebaseUid || !username || !password) {
      return res.status(400).json({ success: false, message: 'firebaseUid, username and password are required' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ success: false, message: 'Invalid username format' });
    }

    const existingUsername = await User.findOne({ username: String(username).toLowerCase() });
    if (existingUsername && existingUsername.firebaseUid !== firebaseUid) {
      return res.status(400).json({ success: false, message: 'Username already taken' });
    }

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.username && String(user.username).trim() && String(user.username).toLowerCase() !== String(username).toLowerCase()) {
      return res.status(409).json({ success: false, message: 'Username cannot be changed once set' });
    }

    user.username = String(username).toLowerCase();
    user.password = await bcrypt.hash(password, 10);
    user.setupComplete = true;
    user.searchableTerms = generateSearchableTerms(user);
    await user.save();

    return res.status(200).json({ success: true, message: 'Setup completed successfully', user });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to complete setup', error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    const user = await User.findOne({ username: String(username).toLowerCase() });
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    user.lastLogin = Date.now();
    await user.save();

    return res.status(200).json({ success: true, message: 'Login successful', user });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Login failed', error: error.message });
  }
});

router.get('/user', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.user.uid });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch user details', error: error.message });
  }
});

router.post('/users-by-phones', verifyToken, async (req, res) => {
  try {
    const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
    if (!phones.length) {
      return res.status(200).json({ success: true, users: [] });
    }

    const normalizedInput = [...new Set(phones.map(normalizePhoneForLookup).filter(Boolean))];
    if (!normalizedInput.length) {
      return res.status(200).json({ success: true, users: [] });
    }

    const activeLinks = await PhoneLink.find({
      phoneNormalized: { $in: normalizedInput },
      isCurrent: true,
    }).lean();

    const historicalLinks = await PhoneLink.find({
      phoneNormalized: { $in: normalizedInput },
      isCurrent: false,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const activeByPhone = new Map();
    activeLinks.forEach(item => activeByPhone.set(String(item.phoneNormalized), item));

    const latestHistoricalByPhone = new Map();
    historicalLinks.forEach(item => {
      const key = String(item.phoneNormalized);
      if (!latestHistoricalByPhone.has(key)) {
        latestHistoricalByPhone.set(key, item);
      }
    });

    const userIds = new Set([
      ...activeLinks.map(item => String(item.userId || '')),
      ...historicalLinks.map(item => String(item.userId || '')),
    ]);

    const users = await User.find({ firebaseUid: { $in: Array.from(userIds).filter(Boolean) } })
      .select('firebaseUid username displayName photoURL mobile mobileNormalized')
      .lean();
    const userById = new Map(users.map(item => [String(item.firebaseUid), item]));
    const fallbackUsers = await User.find({
      $or: [
        { mobileNormalized: { $in: normalizedInput } },
        { mobile: { $in: phones.map(normalizeFullPhone).filter(Boolean) } },
      ],
    })
      .select('firebaseUid username displayName photoURL mobile mobileNormalized')
      .lean();
    const fallbackByPhone = new Map();
    fallbackUsers.forEach(item => {
      const key = String(item.mobileNormalized || normalizePhoneForLookup(item.mobile));
      if (key) {
        fallbackByPhone.set(key, item);
      }
    });

    const result = [];

    for (const phone of normalizedInput) {
      const active = activeByPhone.get(phone);
      if (active) {
        const owner = userById.get(String(active.userId));
        if (owner) {
          result.push({
            id: owner._id,
            userId: owner.firebaseUid,
            firebaseUid: owner.firebaseUid,
            username: owner.username || '',
            displayName: owner.displayName || 'User',
            photoURL: owner.photoURL || null,
            mobile: owner.mobile || '',
            normalizedMobile: owner.mobileNormalized || normalizePhoneForLookup(owner.mobile),
            status: 'app_user',
            queriedPhone: phone,
            currentPhone: owner.mobile || '',
          });
        }
        continue;
      }

      const historical = latestHistoricalByPhone.get(phone);
      if (historical) {
        const owner = userById.get(String(historical.userId));
        if (owner) {
          result.push({
            id: owner._id,
            userId: owner.firebaseUid,
            firebaseUid: owner.firebaseUid,
            username: owner.username || '',
            displayName: owner.displayName || 'User',
            photoURL: owner.photoURL || null,
            mobile: owner.mobile || '',
            normalizedMobile: owner.mobileNormalized || normalizePhoneForLookup(owner.mobile),
            status: 'number_changed',
            queriedPhone: phone,
            currentPhone: owner.mobile || '',
            oldPhone: phone,
          });
        }
      }

      const fallback = fallbackByPhone.get(phone);
      if (fallback) {
        result.push({
          id: fallback._id,
          userId: fallback.firebaseUid,
          firebaseUid: fallback.firebaseUid,
          username: fallback.username || '',
          displayName: fallback.displayName || 'User',
          photoURL: fallback.photoURL || null,
          mobile: fallback.mobile || '',
          normalizedMobile: fallback.mobileNormalized || normalizePhoneForLookup(fallback.mobile),
          status: 'app_user',
          queriedPhone: phone,
          currentPhone: fallback.mobile || '',
        });
      }
    }

    return res.status(200).json({ success: true, users: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch users', error: error.message });
  }
});

router.post('/check-phone', verifyToken, async (req, res) => {
  try {
    const normalizedPhone = normalizePhoneForLookup(req.body?.mobile);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }

    const taken = await isPhoneTaken(normalizedPhone, req.user.uid);
    return res.status(200).json({ success: true, available: !taken });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to check phone number', error: error.message });
  }
});

router.put('/update-profile', verifyToken, async (req, res) => {
  try {
    const {
      displayName,
      mobile,
      dob,
      gender,
      occupation,
      setupComplete,
      country,
      username,
      currency,
      fcmToken,
      bio,
      isOnline,
      lastOnline,
      privacy,
    } = req.body || {};

    const firebaseUid = req.user.uid;

    if (!displayName || String(displayName).trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Valid display name is required' });
    }

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const incomingUsername = String(username || '').trim().toLowerCase();
    if (incomingUsername) {
      if (!validateUsername(incomingUsername)) {
        return res.status(400).json({ success: false, message: 'Invalid username format' });
      }
      if (user.username && String(user.username).trim() && String(user.username).toLowerCase() !== incomingUsername) {
        return res.status(409).json({ success: false, message: 'Username cannot be changed once set' });
      }
      const takenUsername = await User.findOne({ username: incomingUsername, firebaseUid: { $ne: firebaseUid } });
      if (takenUsername) {
        return res.status(400).json({ success: false, message: 'Username already taken' });
      }
      if (!user.username) {
        user.username = incomingUsername;
      }
    }

    const prevNormalized = String(user.mobileNormalized || '');
    const nextFullPhone = mobile ? normalizeFullPhone(mobile) : String(user.mobile || '');
    const nextNormalized = normalizePhoneForLookup(nextFullPhone);

    if (mobile && nextNormalized && nextNormalized !== prevNormalized) {
      const taken = await isPhoneTaken(nextNormalized, firebaseUid);
      if (taken) {
        return res.status(409).json({ success: false, message: 'Phone number already taken' });
      }
    }

    user.displayName = String(displayName).trim();
    if (mobile) {
      user.mobile = nextFullPhone;
      user.mobileNormalized = nextNormalized || null;
    }
    if (dob) user.dob = new Date(dob);
    if (gender) user.gender = gender;
    if (occupation) user.occupation = occupation;
    if (country) user.country = country;
    if (currency) user.currencySymbol = currency;
    if (setupComplete !== undefined) user.setupComplete = setupComplete;
    if (fcmToken) user.fcmToken = fcmToken;
    if (bio !== undefined) user.bio = bio;
    if (isOnline !== undefined) user.isOnline = isOnline;
    if (lastOnline) user.lastOnline = lastOnline;
    if (privacy) user.privacy = { ...user.privacy, ...privacy };

    user.searchableTerms = generateSearchableTerms(user);
    await user.save();

    if (mobile && nextNormalized && nextNormalized !== prevNormalized) {
      await syncPhoneLinks(firebaseUid, nextFullPhone, prevNormalized);
    } else if (mobile && nextNormalized && !prevNormalized) {
      await syncPhoneLinks(firebaseUid, nextFullPhone, prevNormalized);
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update profile', error: error.message });
  }
});

router.post('/phone-claims/request', verifyToken, async (req, res) => {
  try {
    const requesterId = req.user.uid;
    const normalizedPhone = normalizePhoneForLookup(req.body?.phone || req.body?.mobile);

    if (!normalizedPhone) {
      return res.status(400).json({ success: false, message: 'Valid phone is required' });
    }

    const activeOwner = await PhoneLink.findOne({ phoneNormalized: normalizedPhone, isCurrent: true }).lean();
    if (!activeOwner) {
      return res.status(404).json({ success: false, message: 'Phone has no current owner' });
    }

    if (String(activeOwner.userId) === String(requesterId)) {
      return res.status(400).json({ success: false, message: 'Phone already linked to your account' });
    }

    const blocked = await PhoneClaim.findOne({
      requesterId,
      targetOwnerId: String(activeOwner.userId),
      phoneNormalized: normalizedPhone,
      status: 'blocked',
      blockedByTarget: true,
    }).lean();
    if (blocked) {
      return res.status(403).json({ success: false, message: 'You are blocked from requesting this number' });
    }

    const rejectedCount = await PhoneClaim.countDocuments({
      requesterId,
      targetOwnerId: String(activeOwner.userId),
      phoneNormalized: normalizedPhone,
      status: 'rejected',
    });

    const existingPending = await PhoneClaim.findOne({
      requesterId,
      targetOwnerId: String(activeOwner.userId),
      phoneNormalized: normalizedPhone,
      status: 'pending',
    });

    if (existingPending) {
      return res.status(200).json({ success: true, claim: existingPending, message: 'Request already pending' });
    }

    const claim = await PhoneClaim.create({
      requesterId,
      targetOwnerId: String(activeOwner.userId),
      phoneNormalized: normalizedPhone,
      status: 'pending',
      rejectCount: rejectedCount,
    });

    console.log('[PHONE_CLAIM] Notify target owner', {
      targetOwnerId: String(activeOwner.userId),
      requesterId,
      phoneNormalized: normalizedPhone,
    });

    return res.status(200).json({
      success: true,
      claim,
      requiresBlockOption: rejectedCount >= 2,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to create claim request', error: error.message });
  }
});

router.get('/phone-claims/inbox', verifyToken, async (req, res) => {
  try {
    const rows = await PhoneClaim.find({
      targetOwnerId: req.user.uid,
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, claims: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load claim inbox', error: error.message });
  }
});

router.post('/phone-claims/respond', verifyToken, async (req, res) => {
  try {
    const targetOwnerId = req.user.uid;
    const { claimId, action, pinApproved, biometricApproved } = req.body || {};

    const claim = await PhoneClaim.findById(String(claimId || ''));
    if (!claim) {
      return res.status(404).json({ success: false, message: 'Claim not found' });
    }

    if (String(claim.targetOwnerId) !== String(targetOwnerId)) {
      return res.status(403).json({ success: false, message: 'Not allowed to respond to this claim' });
    }

    if (claim.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Claim is no longer pending' });
    }

    if (action === 'reject') {
      claim.status = 'rejected';
      claim.rejectCount = Number(claim.rejectCount || 0) + 1;
      await claim.save();
      return res.status(200).json({ success: true, claim, message: 'Request rejected' });
    }

    if (action === 'block') {
      claim.status = 'blocked';
      claim.blockedByTarget = true;
      await claim.save();
      return res.status(200).json({ success: true, claim, message: 'Requester blocked' });
    }

    if (action !== 'approve') {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    if (!pinApproved && !biometricApproved) {
      return res.status(400).json({ success: false, message: 'PIN or biometric approval is required' });
    }

    const phoneNormalized = String(claim.phoneNormalized || '');
    const requesterId = String(claim.requesterId || '');

    const activeOwnerLink = await PhoneLink.findOne({
      phoneNormalized,
      isCurrent: true,
      userId: targetOwnerId,
    });

    if (!activeOwnerLink) {
      claim.status = 'rejected';
      await claim.save();
      return res.status(409).json({ success: false, message: 'Phone no longer owned by target user' });
    }

    const ownerUser = await User.findOne({ firebaseUid: targetOwnerId });
    const requesterUser = await User.findOne({ firebaseUid: requesterId });
    if (!ownerUser || !requesterUser) {
      return res.status(404).json({ success: false, message: 'Requester or owner account not found' });
    }

    await PhoneLink.updateMany(
      { phoneNormalized, isCurrent: true },
      { $set: { isCurrent: false, validTo: new Date() } },
    );

    await syncPhoneLinks(requesterId, activeOwnerLink.fullPhone || phoneNormalized, '');

    if (String(ownerUser.mobileNormalized || '') === phoneNormalized) {
      ownerUser.mobile = null;
      ownerUser.mobileNormalized = null;
      ownerUser.searchableTerms = generateSearchableTerms(ownerUser);
      await ownerUser.save();
    }

    requesterUser.mobile = activeOwnerLink.fullPhone || phoneNormalized;
    requesterUser.mobileNormalized = phoneNormalized;
    requesterUser.searchableTerms = generateSearchableTerms(requesterUser);
    await requesterUser.save();

    claim.status = 'approved';
    await claim.save();

    console.log('[PHONE_CLAIM] Approved transfer', {
      phoneNormalized,
      from: targetOwnerId,
      to: requesterId,
    });

    return res.status(200).json({
      success: true,
      message: 'Phone transfer approved',
      claim,
      oldOwnerNeedsNewPhone: true,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to respond to claim', error: error.message });
  }
});

router.post('/logout', verifyToken, async (req, res) => {
  return res.status(200).json({ success: true, message: 'Logout successful' });
});

module.exports = router;
