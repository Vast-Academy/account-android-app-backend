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
    kind: {type: String, enum: ['chat', 'ledger'], default: 'chat'},
    payload: {type: mongoose.Schema.Types.Mixed, default: null},
    payloadHash: {type: String, default: ''},
    nextPushAt: {type: Date, default: Date.now},
    leaseId: {type: String, default: null},
    leaseUntil: {type: Date, default: null},
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
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// No automatic expiry for new deliveries. Retention requires an explicit,
// separately reviewed policy; FCM acceptance is never permission to delete.
messageDeliverySchema.index({expiresAt: 1}, {expireAfterSeconds: 0});
messageDeliverySchema.index({conversationId: 1, messageTimestamp: 1});
messageDeliverySchema.index({receiverId: 1, status: 1, _id: 1});
messageDeliverySchema.index({status: 1, nextPushAt: 1, leaseUntil: 1});

module.exports = mongoose.model('MessageDelivery', messageDeliverySchema);
