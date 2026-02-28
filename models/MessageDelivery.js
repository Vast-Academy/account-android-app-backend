const mongoose = require('mongoose');

const messageDeliverySchema = new mongoose.Schema(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    senderId: {
      type: String,
      required: true,
      index: true,
    },
    receiverId: {
      type: String,
      required: true,
      index: true,
    },
    messageText: {
      type: String,
      default: '',
      maxlength: 4000,
    },
    messageTimestamp: {
      type: Number,
      default: 0,
      index: true,
    },
    status: {
      type: String,
      enum: ['accepted', 'pushed', 'delivered', 'read', 'failed'],
      default: 'accepted',
      index: true,
    },
    lastError: {
      type: String,
      default: null,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Auto-clean delivery metadata to keep storage bounded.
messageDeliverySchema.index({expiresAt: 1}, {expireAfterSeconds: 0});

module.exports = mongoose.model('MessageDelivery', messageDeliverySchema);
