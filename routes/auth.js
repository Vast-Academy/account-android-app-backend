const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const User = require('../models/User');
const admin = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');

// Helper function to validate username
const validateUsername = (username) => {
  const regex = /^[a-zA-Z0-9._-]+$/;
  return regex.test(username);
};

// Helper function to generate username suggestions
const generateUsernameSuggestions = async (baseUsername) => {
  const suggestions = [];
  const baseClean = baseUsername.toLowerCase().replace(/[^a-z0-9]/g, '');

  const variants = [
    `${baseClean}_${Math.floor(Math.random() * 1000)}`,
    `${baseClean}.official`,
    `${baseClean}-${new Date().getFullYear()}`,
    `${baseClean}_user`,
    `${baseClean}.${Math.floor(Math.random() * 100)}`,
  ];

  for (const variant of variants) {
    const exists = await User.findOne({ username: variant.toLowerCase() });
    if (!exists) {
      suggestions.push(variant);
      if (suggestions.length >= 4) break;
    }
  }

  return suggestions;
};


// Normalize phone for lookup (digits only, last 10)
const normalizePhoneForLookup = (value) => {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10) return digits.slice(-10);
  if (digits.length < 8) return '';
  return digits;
};

const isPhoneTaken = async (normalizedPhone, excludeUserId = null) => {
  if (!normalizedPhone) {
    return false;
  }

  const query = {
    $or: [
      { searchableTerms: normalizedPhone },
      { mobile: { $regex: `${normalizedPhone}$` } },
    ],
  };

  if (excludeUserId) {
    query._id = { $ne: excludeUserId };
  }

  const candidates = await User.find(query).select('mobile').lean();
  return candidates.some(candidate => {
    return normalizePhoneForLookup(candidate.mobile) === normalizedPhone;
  });
};

// 1. Google Sign-In - Create or Login User
router.post('/google-signin', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'ID token is required'
      });
    }

    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    // Check if user exists in MongoDB
    let user = await User.findOne({ firebaseUid: uid });

    if (!user) {
      // Create new user (setup not complete)
      user = new User({
        firebaseUid: uid,
        email: email,
        displayName: name || email.split('@')[0],
        photoURL: picture || null,
        balance: 0,
        setupComplete: false,
        googleDriveConnected: true
      });
      await user.save();
    } else {
      // Update last login
      user.lastLogin = Date.now();
      await user.save();
    }

    return res.status(200).json({
      success: true,
      setupComplete: user.setupComplete,
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        username: user.username,
        mobile: user.mobile,
        country: user.country,
        currencySymbol: user.currencySymbol,
        balance: user.balance,
        setupComplete: user.setupComplete,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Google Sign-In Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: error.message
    });
  }
});

// 2. Check Username Availability
router.post('/check-username', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: 'Username is required'
      });
    }

    // Validate username format
    if (!validateUsername(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, dots, hyphens, and underscores'
      });
    }

    // Check if username exists (case-insensitive)
    const existingUser = await User.findOne({
      username: username.toLowerCase()
    });

    if (existingUser) {
      // Generate suggestions
      const suggestions = await generateUsernameSuggestions(username);

      return res.status(200).json({
        success: true,
        available: false,
        suggestions: suggestions
      });
    }

    return res.status(200).json({
      success: true,
      available: true
    });

  } catch (error) {
    console.error('Check Username Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to check username',
      error: error.message
    });
  }
});

// 3. Complete Setup (After Google Sign-In)
router.post('/complete-setup', async (req, res) => {
  try {
    const { firebaseUid, username, password } = req.body;

    if (!firebaseUid || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Firebase UID, username, and password are required'
      });
    }

    // Validate username format
    if (!validateUsername(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, dots, hyphens, and underscores'
      });
    }

    // Check if username is available
    const existingUsername = await User.findOne({
      username: username.toLowerCase()
    });

    if (existingUsername) {
      const suggestions = await generateUsernameSuggestions(username);
      return res.status(400).json({
        success: false,
        message: 'Username already taken',
        suggestions: suggestions
      });
    }

    // Find user by firebaseUid
    const user = await User.findOne({ firebaseUid });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Update user
    user.username = username.toLowerCase();
    user.password = hashedPassword;
    user.setupComplete = true;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Setup completed successfully',
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        balance: user.balance
      }
    });

  } catch (error) {
    console.error('Complete Setup Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete setup',
      error: error.message
    });
  }
});

// 4. Username/Password Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    // Find user by username (case-insensitive)
    const user = await User.findOne({
      username: username.toLowerCase()
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    // Check if user has completed setup
    if (!user.setupComplete || !user.password) {
      return res.status(401).json({
        success: false,
        message: 'Please complete setup first using Google Sign-In'
      });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    // Update last login
    user.lastLogin = Date.now();
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        balance: user.balance,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Login Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
});

// 5. Get Current User Details
router.get('/user', verifyToken, async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.user.uid });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        mobile: user.mobile,
        dob: user.dob,
        gender: user.gender,
        occupation: user.occupation,
        country: user.country,
        bio: user.bio,
        fcmToken: user.fcmToken,
        isOnline: user.isOnline,
        lastOnline: user.lastOnline,
        privacy: user.privacy,
        currencySymbol: user.currencySymbol,
        balance: user.balance,
        setupComplete: user.setupComplete,
        googleDriveConnected: user.googleDriveConnected,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Get User Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user details',
      error: error.message
    });
  }
});

// 6. Lookup Users By Phones
router.post('/users-by-phones', verifyToken, async (req, res) => {
  try {
    const { phones } = req.body;

    if (!Array.isArray(phones)) {
      return res.status(400).json({
        success: false,
        message: 'phones array is required'
      });
    }

    const normalized = Array.from(new Set(
      phones.map(normalizePhoneForLookup).filter(Boolean)
    ));

    if (normalized.length === 0) {
      return res.status(200).json({ success: true, users: [] });
    }

    // Search for both normalized (10 digits) and original formats (with country code)
    const searchPhones = new Set([
      ...normalized,  // 10-digit format: "9876543210"
      ...phones       // Original format: "+919876543210"
    ]);

    const users = await User.find({ mobile: { $in: Array.from(searchPhones) } })
      .select('displayName mobile photoURL firebaseUid username')
      .lean();

    const sanitized = users.map(user => ({
      id: user._id,
      userId: user.firebaseUid || user._id.toString(),  // ← ADD THIS: Fallback to MongoDB ID
      firebaseUid: user.firebaseUid,
      displayName: user.displayName,
      photoURL: user.photoURL || null,
      mobile: normalizePhoneForLookup(user.mobile) || user.mobile,
    }));

    return res.status(200).json({
      success: true,
      users: sanitized
    });
  } catch (error) {
    console.error('Users By Phones Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
});

// 7. Logout
router.post('/logout', verifyToken, async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Logout Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: error.message
    });
  }
});

// 8. Check Phone Availability
router.post('/check-phone', verifyToken, async (req, res) => {
  try {
    const { mobile } = req.body;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    const currentUser = await User.findOne({ firebaseUid: req.user.uid });
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const normalizedPhone = normalizePhoneForLookup(mobile);
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number'
      });
    }

    const taken = await isPhoneTaken(normalizedPhone, currentUser._id);

    return res.status(200).json({
      success: true,
      available: !taken
    });
  } catch (error) {
    console.error('Check Phone Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to check phone number',
      error: error.message
    });
  }
});

// 9. Update Profile
router.put('/update-profile', async (req, res) => {
  try {
    const {
      firebaseUid,
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
      privacy
    } = req.body;

    // Validation
    if (!firebaseUid || !displayName) {
      return res.status(400).json({
        success: false,
        message: 'Firebase UID and display name are required'
      });
    }

    // Validate display name
    if (displayName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Display name must be at least 2 characters'
      });
    }

    // Validate username if provided
    if (username) {
      if (!validateUsername(username)) {
        return res.status(400).json({
          success: false,
          message: 'Username can only contain letters, numbers, dots, hyphens, and underscores'
        });
      }

      // Check if username is already taken (and different from current user's username)
      const user = await User.findOne({ firebaseUid });
      const existingUser = await User.findOne({ username: username.toLowerCase() });
      if (existingUser && existingUser._id.toString() !== user._id.toString()) {
        return res.status(400).json({
          success: false,
          message: 'Username already taken'
        });
      }
    }

    // Find user
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (mobile) {
      const normalizedPhone = normalizePhoneForLookup(mobile);
      if (normalizedPhone) {
        const taken = await isPhoneTaken(normalizedPhone, user._id);
        if (taken) {
          return res.status(409).json({
            success: false,
            message: 'Phone number already taken'
          });
        }
      }
    }

    // Update existing fields
    user.displayName = displayName.trim();
    if (mobile) user.mobile = mobile;
    if (dob) user.dob = new Date(dob);
    if (gender) user.gender = gender;
    if (occupation) user.occupation = occupation;
    if (country) user.country = country;
    if (username) user.username = username.toLowerCase();
    if (currency) user.currencySymbol = currency;
    if (setupComplete !== undefined) user.setupComplete = setupComplete;

    // Update chat-related fields
    if (fcmToken) user.fcmToken = fcmToken;
    if (bio) user.bio = bio;
    if (isOnline !== undefined) user.isOnline = isOnline;
    if (lastOnline) user.lastOnline = lastOnline;
    if (privacy) user.privacy = { ...user.privacy, ...privacy };

    // Auto-generate searchableTerms from displayName, username, and mobile
    user.searchableTerms = [
      user.displayName.toLowerCase(),
      user.username ? user.username.toLowerCase() : '',
      user.mobile ? normalizePhoneForLookup(user.mobile) : ''
    ].filter(Boolean);

    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        mobile: user.mobile,
        dob: user.dob,
        gender: user.gender,
        occupation: user.occupation,
        country: user.country,
        username: user.username,
        currencySymbol: user.currencySymbol,
        fcmToken: user.fcmToken,
        bio: user.bio,
        isOnline: user.isOnline,
        lastOnline: user.lastOnline,
        privacy: user.privacy,
        setupComplete: user.setupComplete,
        balance: user.balance,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Update Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
});

module.exports = router;
