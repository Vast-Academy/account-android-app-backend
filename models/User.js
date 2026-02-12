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
  mobileNormalized: {
    type: String,
    default: null,
    index: true
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
  profileSchemaVersion: {
    type: Number,
    default: 1
  },
  needsProfileRefresh: {
    type: Boolean,
    default: false
  },
  country: {
    type: String,
    default: null
  },
  username: {
    type: String,
    lowercase: true
  },
  fcmToken: {
    type: String,
    default: null
  },
  searchableTerms: {
    type: [String],
    default: [],
    index: true
  },
  bio: {
    type: String,
    default: null,
    maxlength: 150
  },
  isOnline: {
    type: Boolean,
    default: false
  },
  lastOnline: {
    type: Date,
    default: null
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
  }
});

// Enforce uniqueness only when username is a real string (not null/empty)
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string', $ne: '' } } }
);

module.exports = mongoose.model('User', userSchema);
