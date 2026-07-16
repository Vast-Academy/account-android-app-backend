const User = require('../models/User');

/**
 * SSOT (Single Source of Truth) Contact Reconciliation Service
 * Handles merging of non-app user contacts with app user contacts
 * Source of Truth: Backend MongoDB
 */

const normalizePhoneForLookup = (phone) => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length > 10) return digits.slice(-10);
  return digits.length >= 8 ? digits : '';
};

/**
 * Find contact by EITHER firebaseUid OR normalized phone
 * This implements the dual-lookup at source of truth level
 */
const findContactByIdentifiers = async (firebaseUid, phone) => {
  const normalized = normalizePhoneForLookup(phone);

  // Try firebaseUid first (primary identifier)
  if (firebaseUid) {
    const byUid = await User.findOne({ firebaseUid }).lean();
    if (byUid) return byUid;
  }

  // Fallback to normalized phone (secondary identifier)
  if (normalized) {
    const byPhone = await User.findOne({ mobileNormalized: normalized }).lean();
    if (byPhone) return byPhone;
  }

  return null;
};

/**
 * Reconcile two contacts:
 * Merges non-app user contact with app user contact
 * When someone installs the app after being a contact
 */
const reconcileContactsOnAppInstall = async (firebaseUid, phone) => {
  try {
    const normalized = normalizePhoneForLookup(phone);

    if (!normalized) {
      console.log('[RECONCILE] No valid phone to reconcile with:', phone);
      return { success: false, reason: 'invalid_phone' };
    }

    // Find old contact (phone-based, non-app user)
    const oldContact = await User.findOne({ mobileNormalized: normalized }).lean();

    if (!oldContact) {
      console.log('[RECONCILE] No old contact found for phone:', normalized);
      return { success: false, reason: 'no_old_contact' };
    }

    // If old contact already has this firebaseUid, no need to reconcile
    if (oldContact.firebaseUid === firebaseUid) {
      console.log('[RECONCILE] Already reconciled:', firebaseUid);
      return { success: true, reason: 'already_reconciled' };
    }

    // If old contact has a different firebaseUid, we have a conflict
    if (oldContact.firebaseUid && oldContact.firebaseUid !== firebaseUid) {
      console.log('[RECONCILE] Conflict: Different firebaseUid detected');
      return {
        success: false,
        reason: 'uid_conflict',
        details: {
          oldUid: oldContact.firebaseUid,
          newUid: firebaseUid,
        },
      };
    }

    // Find new contact (app user with firebaseUid)
    const newContact = await User.findOne({ firebaseUid }).lean();

    if (!newContact) {
      console.log('[RECONCILE] No new contact found for firebaseUid:', firebaseUid);
      return { success: false, reason: 'no_new_contact' };
    }

    // Merge: Update old contact with new firebaseUid and app status
    const mergedContact = await User.updateOne(
      { _id: oldContact._id },
      {
        firebaseUid: firebaseUid,
        appInstallState: 'installed',
        // Preserve existing data, but update with app user info if needed
        displayName: newContact.displayName || oldContact.displayName,
        username: newContact.username || oldContact.username,
        photoURL: newContact.photoURL || oldContact.photoURL,
        bio: newContact.bio || oldContact.bio,
      },
      { new: true }
    );

    console.log('[RECONCILE] Successfully merged contacts:', {
      oldId: oldContact._id,
      newId: newContact._id,
      firebaseUid,
      phone: normalized,
    });

    return {
      success: true,
      mergedContact,
      oldContactId: oldContact._id,
      newContactId: newContact._id,
    };
  } catch (error) {
    console.error('[RECONCILE] Error during reconciliation:', error);
    return {
      success: false,
      reason: 'error',
      error: error.message,
    };
  }
};

/**
 * Get contact info for dual-path query
 * Returns contact found by firebaseUid OR phone
 */
const getContactByDualPath = async (firebaseUid, phone) => {
  try {
    const contact = await findContactByIdentifiers(firebaseUid, phone);
    return contact;
  } catch (error) {
    console.error('[DUAL_PATH] Error:', error);
    return null;
  }
};

/**
 * Ensure phone normalization is consistent
 * Called during profile updates to maintain SSOT
 */
const normalizeAndUpdatePhone = async (userId, phone) => {
  try {
    const normalized = normalizePhoneForLookup(phone);

    if (!normalized) {
      return { success: false, reason: 'invalid_phone' };
    }

    await User.updateOne(
      { _id: userId },
      { mobile: phone, mobileNormalized: normalized }
    );

    return { success: true, normalized };
  } catch (error) {
    console.error('[NORMALIZE_PHONE] Error:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  findContactByIdentifiers,
  reconcileContactsOnAppInstall,
  getContactByDualPath,
  normalizeAndUpdatePhone,
  normalizePhoneForLookup,
};
