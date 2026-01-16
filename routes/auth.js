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
        balance: user.balance,
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
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
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

// 6. Logout
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

// 7. Update Profile
router.put('/update-profile', async (req, res) => {
  try {
    const { firebaseUid, displayName, mobile, dob, gender, occupation, setupComplete } = req.body;

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

    // Validate mobile number if provided
    if (mobile && !/^\d{10}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number must be 10 digits'
      });
    }

    // Find user
    const user = await User.findOne({ firebaseUid });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update fields
    user.displayName = displayName.trim();
    if (mobile) user.mobile = mobile;
    if (dob) user.dob = new Date(dob);
    if (gender) user.gender = gender;
    if (occupation) user.occupation = occupation;
    if (setupComplete !== undefined) user.setupComplete = setupComplete;

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
