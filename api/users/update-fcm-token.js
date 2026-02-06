const mongoose = require('mongoose');

// Initialize MongoDB if not already done
let isInitialized = false;

const initialize = async () => {
  if (isInitialized) return;

  // Connect to MongoDB if not connected
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  isInitialized = true;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initialize();

    const { userId, fcmToken } = req.body;

    // Validate required fields
    if (!userId || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'userId and fcmToken are required'
      });
    }

    // Get User model
    const User = mongoose.model('User');

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

    return res.status(200).json({
      success: true,
      message: 'FCM token updated successfully'
    });

  } catch (error) {
    console.error('FCM token update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
