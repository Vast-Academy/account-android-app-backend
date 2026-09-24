const mongoose = require('mongoose');

const phoneClaimSchema = new mongoose.Schema({
  phoneNormalized: {
    type: String,
    required: true,
    index: true,
  },
  targetOwnerId: {
    type: String,
    required: true,
    index: true,
  },
  requesterId: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'blocked'],
    default: 'pending',
    index: true,
  },
  rejectCount: {
    type: Number,
    default: 0,
  },
  blockedByTarget: {
    type: Boolean,
    default: false,
  },
}, {timestamps: true});

phoneClaimSchema.index({phoneNormalized: 1, requesterId: 1, targetOwnerId: 1, status: 1});

module.exports = mongoose.model('PhoneClaim', phoneClaimSchema);
