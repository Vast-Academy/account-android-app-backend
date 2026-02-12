require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const User = require('../models/User');

const PROFILE_SCHEMA_VERSION = 2;

const normalizePhoneForLookup = value => {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 10) return digits.slice(-10);
  if (digits.length < 8) return '';
  return digits;
};

const buildSearchableTerms = user => {
  return [
    String(user?.displayName || '').toLowerCase(),
    String(user?.username || '').toLowerCase(),
    normalizePhoneForLookup(user?.mobile),
  ].filter(Boolean);
};

const run = async () => {
  await connectDB();

  const users = await User.find({});
  let updated = 0;
  let flagged = 0;

  for (const user of users) {
    const normalizedMobile = normalizePhoneForLookup(user.mobile);
    const nextNeedsRefresh =
      Number(user.profileSchemaVersion || 0) < PROFILE_SCHEMA_VERSION || !normalizedMobile;

    const nextFields = {
      mobileNormalized: normalizedMobile || null,
      searchableTerms: buildSearchableTerms(user),
      profileSchemaVersion: PROFILE_SCHEMA_VERSION,
      needsProfileRefresh: nextNeedsRefresh,
    };

    const changed =
      String(user.mobileNormalized || '') !== String(nextFields.mobileNormalized || '') ||
      JSON.stringify(user.searchableTerms || []) !== JSON.stringify(nextFields.searchableTerms || []) ||
      Number(user.profileSchemaVersion || 0) !== PROFILE_SCHEMA_VERSION ||
      Boolean(user.needsProfileRefresh) !== Boolean(nextNeedsRefresh);

    if (!changed) {
      continue;
    }

    await User.updateOne({_id: user._id}, {$set: nextFields});
    updated += 1;
    if (nextNeedsRefresh) flagged += 1;
  }

  console.log('[Migration] profile schema v2 completed');
  console.log(`[Migration] total users: ${users.length}`);
  console.log(`[Migration] updated users: ${updated}`);
  console.log(`[Migration] flagged for profile refresh: ${flagged}`);
};

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async error => {
    console.error('[Migration] failed:', error);
    try {
      await mongoose.connection.close();
    } catch {}
    process.exit(1);
  });

