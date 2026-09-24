const mongoose = require('mongoose');

const phoneLinkSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true,
  },
  phoneNormalized: {
    type: String,
    required: true,
    index: true,
  },
  fullPhone: {
    type: String,
    default: '',
  },
  isCurrent: {
    type: Boolean,
    default: true,
    index: true,
  },
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validTo: {
    type: Date,
    default: null,
  },
}, {timestamps: true});

// Allow one active owner for a normalized phone.
phoneLinkSchema.index(
  {phoneNormalized: 1, isCurrent: 1},
  {unique: true, partialFilterExpression: {isCurrent: true}},
);

module.exports = mongoose.model('PhoneLink', phoneLinkSchema);
