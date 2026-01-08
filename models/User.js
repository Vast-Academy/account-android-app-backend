const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebaseUid: {
    type: String,
    unique: true,
    sparse: true,
    default: null
  },
  username: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    default: null
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    default: null
  },
  displayName: {
    type: String,
    required: true
  },
  photoURL: {
    type: String,
    default: null
  },
  balance: {
    type: Number,
    default: 0
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
  }
});

module.exports = mongoose.model('User', userSchema);
