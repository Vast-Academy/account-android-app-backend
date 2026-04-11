const normalizeText = value => {
  const text = String(value ?? '').trim();
  return text || null;
};

const normalizePhoneForLookup = value => {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 10) return digits.slice(-10);
  if (digits.length < 8) return null;
  return digits;
};

const resolveProfileState = user => {
  const username = normalizeText(user?.username);
  const phoneNumber =
    normalizeText(user?.mobile) || normalizeText(user?.phoneNumber);
  const setupComplete = user?.setupComplete === true;

  if (setupComplete && username && phoneNumber) {
    return 'profileReady';
  }
  if (username || phoneNumber) {
    return 'profilePartial';
  }
  return 'authCreated';
};

const toIsoString = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const buildCanonicalUser = (user, options = {}) => {
  const includeMongoId = options.includeMongoId === true;
  const includeEmail = options.includeEmail !== false;
  const includePrivatePhone = options.includePrivatePhone !== false;

  const firebaseUid = normalizeText(user?.firebaseUid);
  const phoneNumber = includePrivatePhone
    ? normalizeText(user?.mobile) || normalizeText(user?.phoneNumber)
    : null;
  const phoneNumberNormalized =
    includePrivatePhone
      ? normalizeText(user?.mobileNormalized) ||
        normalizePhoneForLookup(user?.mobile || user?.phoneNumber)
      : null;

  const payload = {
    firebaseUid,
    userId: firebaseUid,
    displayName: normalizeText(user?.displayName),
    username: normalizeText(user?.username),
    phoneNumber,
    phoneNumberNormalized,
    country: normalizeText(user?.country),
    setupComplete: user?.setupComplete === true,
    profileState: resolveProfileState(user),
    photoURL: normalizeText(user?.photoURL),
    appInstallState: normalizeText(user?.appInstallState) || 'installed',
    phoneOwnershipState: normalizeText(user?.phoneOwnershipState) || (phoneNumberNormalized ? 'active' : 'released'),
    updatedAt:
      toIsoString(user?.updatedAt) ||
      toIsoString(user?.lastLogin) ||
      toIsoString(user?.createdAt),

    // Compatibility aliases for existing app code.
    mobile: phoneNumber,
    mobileNormalized: phoneNumberNormalized,
    name: normalizeText(user?.displayName),
    currencySymbol: normalizeText(user?.currencySymbol),
    email: includeEmail ? normalizeText(user?.email) : null,
    occupation: normalizeText(user?.occupation),
    gender: normalizeText(user?.gender),
    bio: normalizeText(user?.bio),
    privacy:
      user?.privacy && typeof user.privacy === 'object'
        ? {
            phoneNumberVisible: user.privacy.phoneNumberVisible !== false,
            lastSeenVisible: user.privacy.lastSeenVisible !== false,
            profilePhotoVisible: user.privacy.profilePhotoVisible !== false,
          }
        : {
            phoneNumberVisible: true,
            lastSeenVisible: true,
            profilePhotoVisible: true,
          },
  };

  if (includeMongoId && user?._id) {
    payload.id = String(user._id);
  }

  return payload;
};

const buildBootstrapPayload = user => ({
  success: true,
  user: buildCanonicalUser(user, {
    includeMongoId: true,
    includeEmail: true,
    includePrivatePhone: true,
  }),
});

module.exports = {
  buildBootstrapPayload,
  buildCanonicalUser,
  normalizePhoneForLookup,
  resolveProfileState,
};
