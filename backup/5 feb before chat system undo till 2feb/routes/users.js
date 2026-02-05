const express = require('express');
const router = express.Router();
const User = require('../models/User');
const admin = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');

// Helper: Generate searchable terms from user data
const generateSearchTerms = (userData) => {
  const terms = [];

  // Username
  if (userData.username) {
    terms.push(userData.username.toLowerCase());
  }

  // Display name words
  if (userData.displayName) {
    const words = userData.displayName.toLowerCase().split(' ');
    terms.push(...words);
  }

  // Phone number
  if (userData.mobile) {
    terms.push(userData.mobile);
  }

  return [...new Set(terms)]; // Remove duplicates
};

// 1. Sync User Profile to MongoDB (called from app after login)
router.post('/sync-profile', verifyToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const { username, displayName, mobile, phoneNumber, email, photoURL, fcmToken, bio } = req.body;

    const normalizedMobile = mobile || phoneNumber || '';

    // Validate username format
    if (username && !/^[a-zA-Z0-9._-]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, dots, hyphens, and underscores'
      });
    }

    // Check if username is already taken (if different from current)
    const existingUser = await User.findOne({ username: username?.toLowerCase() });
    if (existingUser && existingUser.firebaseUid !== firebaseUid) {
      return res.status(400).json({
        success: false,
        message: 'Username already taken'
      });
    }

    // Generate searchable terms
    const searchableTerms = generateSearchTerms({ username, displayName, mobile: normalizedMobile, bio });

    // Update or create user
    const user = await User.findOneAndUpdate(
      { firebaseUid },
      {
        username: username?.toLowerCase(),
        displayName,
        mobile: normalizedMobile,
        email,
        photoURL,
        bio,
        fcmToken,
        searchableTerms,
        privacy: {
          phoneNumberVisible: true,
          lastSeenVisible: true,
          profilePhotoVisible: true
        },
        lastOnline: new Date()
      },
      { new: true, upsert: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Profile synced successfully',
      user: {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        displayName: user.displayName,
        mobile: user.mobile,
        email: user.email,
        photoURL: user.photoURL,
        fcmToken: user.fcmToken
      }
    });
  } catch (error) {
    console.error('Sync Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync profile',
      error: error.message
    });
  }
});

// 2. Search Users Globally (username, phone, display name)
router.post('/search', verifyToken, async (req, res) => {
  try {
    const { query, limit = 20 } = req.body;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required'
      });
    }

    const searchTerm = query.toLowerCase().trim();

    // Search by username, displayName, or phone number
    const users = await User.find({
      $or: [
        { username: { $regex: searchTerm, $options: 'i' } },
        { displayName: { $regex: searchTerm, $options: 'i' } },
        { mobile: { $regex: searchTerm, $options: 'i' } },
        { searchableTerms: searchTerm }
      ],
      setupComplete: true // Only return users who completed setup
    })
      .select('_id firebaseUid username displayName photoURL bio mobile privacy')
      .limit(parseInt(limit))
      .lean();

    // Filter by privacy settings (hide phone if not visible)
    const filteredUsers = users.map(user => {
      const userData = {
        id: user._id,
        userId: user.firebaseUid,
        username: user.username,
        displayName: user.displayName,
        photoURL: user.photoURL
      };

      // Only include phone if privacy allows
      if (user.privacy?.phoneNumberVisible) {
        userData.mobile = user.mobile;
      }

      return userData;
    });

    return res.status(200).json({
      success: true,
      users: filteredUsers
    });
  } catch (error) {
    console.error('Search Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Search failed',
      error: error.message
    });
  }
});

// 3. Get User by Username
router.get('/by-username/:username', verifyToken, async (req, res) => {
  try {
    const { username } = req.params;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: 'Username is required'
      });
    }

    const user = await User.findOne({
      username: username.toLowerCase(),
      setupComplete: true
    }).select('_id firebaseUid username displayName photoURL bio mobile privacy').lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Apply privacy settings
    const userData = {
      id: user._id,
      userId: user.firebaseUid,
      username: user.username,
      displayName: user.displayName,
      photoURL: user.photoURL
    };

    if (user.privacy?.phoneNumberVisible) {
      userData.mobile = user.mobile;
    }

    return res.status(200).json({
      success: true,
      user: userData
    });
  } catch (error) {
    console.error('Get User by Username Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message
    });
  }
});

// 4. Get User Profile by ID
router.get('/:userId/profile', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const user = await User.findOne({
      firebaseUid: userId,
      setupComplete: true
    }).select('_id firebaseUid username displayName photoURL bio mobile privacy isOnline lastOnline').lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Apply privacy settings
    const userData = {
      id: user._id,
      userId: user.firebaseUid,
      username: user.username,
      displayName: user.displayName,
      photoURL: user.photoURL,
      isOnline: user.isOnline
    };

    if (user.privacy?.phoneNumberVisible) {
      userData.mobile = user.mobile;
    }

    if (user.privacy?.lastSeenVisible) {
      userData.lastOnline = user.lastOnline;
    }

    return res.status(200).json({
      success: true,
      user: userData
    });
  } catch (error) {
    console.error('Get User Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user profile',
      error: error.message
    });
  }
});

// 5. Batch Search Users by Phone Numbers (WhatsApp-style)
router.post('/batch-search', verifyToken, async (req, res) => {
  try {
    const { phoneNumbers } = req.body;

    // Validate input
    if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Phone numbers array is required'
      });
    }

    // Limit batch size to prevent abuse (max 2000 contacts)
    if (phoneNumbers.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 2000 phone numbers allowed per batch'
      });
    }

    // Clean and normalize phone numbers (remove non-digits, keep last 10 digits)
    const cleanedPhones = phoneNumbers.map(phone => {
      const cleaned = String(phone).replace(/\D/g, '');
      return cleaned.slice(-10); // Get last 10 digits
    }).filter(phone => phone.length === 10); // Only keep valid 10-digit numbers

    if (cleanedPhones.length === 0) {
      return res.status(200).json({
        success: true,
        users: {}
      });
    }

    // Single database query using $in operator - finds all matching users at once
    const users = await User.find({
      $or: [
        { mobile: { $in: cleanedPhones } },
        {
          mobile: {
            $in: cleanedPhones.map(phone => `+91${phone}`) // Also check with country code
          }
        }
      ],
      setupComplete: true
    })
    .select('_id firebaseUid username displayName photoURL mobile privacy')
    .lean();

    // Build hash map for O(1) lookup: { "9876543210": userData, ... }
    const userMap = {};

    users.forEach(user => {
      // Extract clean phone number (last 10 digits)
      const cleanPhone = user.mobile ? user.mobile.replace(/\D/g, '').slice(-10) : null;

      if (cleanPhone && cleanPhone.length === 10) {
        // Apply privacy settings
        const userData = {
          id: user._id,
          userId: user.firebaseUid,
          username: user.username,
          displayName: user.displayName,
          photoURL: user.photoURL,
          isAppUser: true
        };

        // Only include phone if privacy allows
        if (user.privacy?.phoneNumberVisible) {
          userData.mobile = user.mobile;
        }

        // Store in map using clean phone as key
        userMap[cleanPhone] = userData;
      }
    });

    return res.status(200).json({
      success: true,
      users: userMap,
      totalRequested: phoneNumbers.length,
      totalFound: Object.keys(userMap).length
    });
  } catch (error) {
    console.error('Batch Search Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Batch search failed',
      error: error.message
    });
  }
});

// 6. Update FCM Token
router.post('/update-fcm-token', verifyToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    const user = await User.findOneAndUpdate(
      { firebaseUid },
      { fcmToken, lastOnline: new Date() },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'FCM token updated'
    });
  } catch (error) {
    console.error('Update FCM Token Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update FCM token',
      error: error.message
    });
  }
});

module.exports = router;
