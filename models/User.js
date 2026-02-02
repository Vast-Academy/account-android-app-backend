const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: {
    type: String,
    unique: true,
    sparse: true,
    default: null
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  displayName: {
    type: String,
    required: true
  },
  photoURL: {
    type: String,
    default: null
  },
  mobile: {
    type: String,
    default: null
  },
  gender: {
    type: String,
    enum: ['Male', 'Female', 'Other'],
    default: null
  },
  occupation: {
    type: String,
    default: null
  },
  currencySymbol: {
    type: String,
    default: null
  },
  setupComplete: {
    type: Boolean,
    default: false
  },
  googleDriveConnected: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  // Chat Feature Fields
  username: {
    type: String,
    lowercase: true,
    sparse: true
  },
  searchableTerms: {
    type: [String],
    default: []
  },
  tumneToken: {
    type: String,
    default: null
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastOnline: {
    type: Date,
    default: Date.now
  },
  privacy: {
    phoneNumberVisible: {
      type: Boolean,
      default: true
    },
    lastSeenVisible: {
      type: Boolean,
      default: true
    },
    profilePhotoVisible: {
      type: Boolean,
      default: true
    }
  }
});

// Create indexes for chat search
userSchema.index({ username: 1 });
userSchema.index({ searchableTerms: 1 });
userSchema.index({ phoneNumber: 1 });

module.exports = mongoose.model('User', userSchema);
