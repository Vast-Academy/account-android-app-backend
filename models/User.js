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
  country: {
    type: String,
    default: null
  },
  username: {
    type: String,
    unique: true,
    sparse: true,
    default: null,
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

module.exports = mongoose.model('User', userSchema);