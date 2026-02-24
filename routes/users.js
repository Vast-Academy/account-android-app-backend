const express = require('express');
const router = express.Router();
const User = require('../models/User');
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

// POST /api/users/sync-profile
router.post('/sync-profile', verifyToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const { username, displayName, mobile, email, photoURL, fcmToken, searchableTerms, privacy } = req.body;

    // Validate username format if provided
    if (username && !/^[a-zA-Z0-9._-]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, dots, hyphens, and underscores'
      });
    }

    // Check if username is already taken (if different from current)
    if (username) {
      const existingUser = await User.findOne({ username: username.toLowerCase() });
      if (existingUser && existingUser.firebaseUid !== firebaseUid) {
        return res.status(400).json({
          success: false,
          message: 'Username already taken'
        });
      }
    }

    // If username is empty, keep the existing username (don't overwrite)
    let finalUsername = username?.toLowerCase();
    if (!finalUsername || finalUsername.trim() === '') {
      const existingUser = await User.findOne({ firebaseUid });
      if (existingUser && existingUser.username) {
        finalUsername = existingUser.username;  // ← Keep existing
      }
    }

    // Generate searchable terms if not provided
    const finalSearchableTerms = searchableTerms || generateSearchTerms({ username: finalUsername, displayName, mobile });

    // Update or create user
    const user = await User.findOneAndUpdate(
      { firebaseUid },
      {
        username: finalUsername,
        displayName,
        mobile,
        email,
        photoURL,
        fcmToken,
        searchableTerms: finalSearchableTerms,
        privacy: privacy || {
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
    console.error('❌ Sync Profile Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync profile',
      error: error.message
    });
  }
});

// POST /api/users/search
router.post('/search', verifyToken, async (req, res) => {
  try {
    const { query } = req.body;

    // Validate query
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'query parameter is required and must be a non-empty string'
      });
    }

    const searchQuery = query.trim().toLowerCase();

    // Search users by:
    // 1. searchableTerms array (indexed for fast search)
    // 2. username
    // 3. displayName
    const users = await User.find({
      $or: [
        { searchableTerms: { $regex: searchQuery, $options: 'i' } },
        { username: { $regex: searchQuery, $options: 'i' } },
        { displayName: { $regex: searchQuery, $options: 'i' } }
      ]
    })
      .select('firebaseUid username displayName photoURL mobile email')
      .limit(20)
      .lean();

    // Sanitize results based on privacy settings
    const sanitizedUsers = users.map(user => {
      const result = {
        id: user._id,
        firebaseUid: user.firebaseUid,
        username: user.username,
        displayName: user.displayName,
        photoURL: user.photoURL,
        email: user.email
      };

      // Include phone number only if user wants it visible
      if (user.privacy?.phoneNumberVisible !== false) {
        result.mobile = user.mobile;
      }

      return result;
    });

    return res.status(200).json({
      success: true,
      users: sanitizedUsers
    });

  } catch (error) {
    console.error('❌ User search error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/users/update-fcm-token
router.post('/update-fcm-token', verifyToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user?.uid;

    if (!userId || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'userId (from token) and fcmToken are required'
      });
    }

    // Find user by firebaseUid
    const user = await User.findOne({ firebaseUid: userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update FCM token and online status
    user.fcmToken = fcmToken;
    user.lastOnline = new Date();
    user.isOnline = true;

    await user.save();

    console.log('✅ FCM token updated for user:', userId);
    return res.status(200).json({
      success: true,
      message: 'FCM token updated successfully'
    });

  } catch (error) {
    console.error('❌ FCM token update error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
