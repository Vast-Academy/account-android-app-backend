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

    const { query } = req.body;

    // Validate query
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'query parameter is required and must be a non-empty string'
      });
    }

    const searchQuery = query.trim().toLowerCase();

    // Get User model
    const User = mongoose.model('User');

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
    console.error('User search error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
