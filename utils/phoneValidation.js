const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

/**
 * Validate and parse international phone number
 * @param {string} phone - Phone number (can be with or without country code)
 * @param {string} countryCode - ISO country code (e.g., 'IN', 'US', 'GB')
 * @returns {object} - { valid: boolean, data: {...} or error: string }
 */
const validateInternationalPhone = (phone, countryCode) => {
  try {
    if (!phone || !countryCode) {
      return {
        valid: false,
        error: 'Phone and country code are required'
      };
    }

    // Remove any whitespace, dashes, parentheses
    const cleanedPhone = phone.replace(/[\s\-\(\)]/g, '');

    // Validate phone number for given country
    if (!isValidPhoneNumber(cleanedPhone, countryCode)) {
      return {
        valid: false,
        error: `Invalid phone number for ${countryCode}`
      };
    }

    const parsed = parsePhoneNumber(cleanedPhone, countryCode);

    return {
      valid: true,
      data: {
        internationalFormat: parsed.formatInternational(),    // e.g., "+91 98765 43210"
        e164Format: parsed.format('E.164'),                   // e.g., "+919876543210"
        nationalFormat: parsed.formatNational(),              // e.g., "98765 43210"
        country: parsed.country,                              // e.g., "IN"
        dialingCode: '+' + parsed.countryCallingCode,          // e.g., "+91"
        nationalNumber: parsed.nationalNumber                 // e.g., "9876543210"
      }
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message || 'Error validating phone number'
    };
  }
};

/**
 * Get country dial code (e.g., "+91" for India)
 * @param {string} countryCode - ISO country code
 * @returns {string} - Dial code with + prefix
 */
const getCountryDialCode = (countryCode) => {
  const countryDialCodes = {
    'IN': '+91',
    'US': '+1',
    'GB': '+44',
    'CA': '+1',
    'AU': '+61',
    'DE': '+49',
    'FR': '+33',
    'JP': '+81',
    'CN': '+86',
    'BR': '+55',
    'MX': '+52',
    'IT': '+39',
    'ES': '+34',
    'NZ': '+64',
    'SG': '+65',
    'HK': '+852',
    'AE': '+971',
    'ZA': '+27',
    'RU': '+7'
  };

  return countryDialCodes[countryCode] || null;
};

module.exports = {
  validateInternationalPhone,
  getCountryDialCode
};
