/**
 * SSOT Contact Reconciliation Migration Script
 * Reconciles existing non-app user contacts with app user contacts
 *
 * Usage: node reconcileExistingContacts.js
 */

const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const { reconcileContactsOnAppInstall } = require('../services/contactReconciliationService');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/savingo';

const normalizePhoneForLookup = (phone) => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length > 10) return digits.slice(-10);
  return digits.length >= 8 ? digits : '';
};

async function main() {
  try {
    console.log('🔄 [RECONCILE_SCRIPT] Starting contact reconciliation...');
    console.log('📊 [RECONCILE_SCRIPT] Connecting to MongoDB:', MONGO_URI);

    await mongoose.connect(MONGO_URI);
    console.log('✅ [RECONCILE_SCRIPT] Connected to MongoDB');

    // Find all app users (have firebaseUid)
    const appUsers = await User.find({ firebaseUid: { $exists: true, $ne: null } }).lean();
    console.log(`📋 [RECONCILE_SCRIPT] Found ${appUsers.length} app users`);

    let reconciled = 0;
    let skipped = 0;
    let errors = 0;

    for (const appUser of appUsers) {
      const phone = normalizePhoneForLookup(appUser.mobile);

      if (!phone) {
        console.log(`⏭️  [RECONCILE_SCRIPT] Skipping ${appUser.firebaseUid} - no phone`);
        skipped++;
        continue;
      }

      // Check if there's an old non-app contact with this phone
      const oldContact = await User.findOne({
        mobileNormalized: phone,
        firebaseUid: { $exists: false },
      }).lean();

      if (!oldContact) {
        skipped++;
        continue;
      }

      try {
        console.log(`🔗 [RECONCILE_SCRIPT] Reconciling ${appUser.firebaseUid} with old contact ${oldContact._id}`);

        const result = await reconcileContactsOnAppInstall(
          appUser.firebaseUid,
          appUser.mobile
        );

        if (result.success) {
          console.log(`✅ [RECONCILE_SCRIPT] Successfully reconciled: ${appUser.firebaseUid}`);
          reconciled++;
        } else {
          console.log(`⚠️  [RECONCILE_SCRIPT] Skipped: ${result.reason}`);
          skipped++;
        }
      } catch (error) {
        console.error(`❌ [RECONCILE_SCRIPT] Error reconciling ${appUser.firebaseUid}:`, error.message);
        errors++;
      }
    }

    console.log('\n📊 [RECONCILE_SCRIPT] Migration Summary:');
    console.log(`  ✅ Reconciled: ${reconciled}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  ❌ Errors: ${errors}`);

    await mongoose.disconnect();
    console.log('\n✅ [RECONCILE_SCRIPT] Script completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ [RECONCILE_SCRIPT] Fatal error:', error);
    process.exit(1);
  }
}

main();
