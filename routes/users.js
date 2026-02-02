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

  // Bio keywords
  if (userData.bio) {
    const bioWords = userData.bio.toLowerCase().split(' ').filter(w => w.length > 3);
    terms.push(...bioWords.slice(0, 5));
  }

  return [...new Set(terms)]; // Remove duplicates
};

// 1. Sync User Profile to MongoDB (called from app after login)
router.post('/sync-profile', verifyToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const { username, displayName, mobile, email, photoURL, bio, fcmToken } = req.body;

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
    const searchableTerms = generateSearchTerms({ username, displayName, mobile, bio });

    // Update or create user
    const user = await User.findOneAndUpdate(
      { firebaseUid },
      {
        username: username?.toLowerCase(),
        displayName,
        mobile,
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
        bio: user.bio,
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
        photoURL: user.photoURL,
        bio: user.bio
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
      photoURL: user.photoURL,
      bio: user.bio
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
      bio: user.bio,
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

// 5. Update FCM Token
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
