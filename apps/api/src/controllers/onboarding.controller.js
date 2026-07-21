const { isValidName } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const onboardingService = require('../onboarding/onboarding.service');

// GET /api/onboarding/:token — the browser form's initial load. Only ever
// returns display-safe fields (name to prefill, nothing else about the
// user) since the token alone is treated as the credential from here on.
const getOnboarding = async (req, res, next) => {
  try {
    const user = await onboardingService.findByRegistrationToken(req.params.token);
    if (!user) return sendError(res, 'This link is invalid or has expired.', 410);

    return sendSuccess(res, { name: user.preferredName || '' }, 'Link is valid');
  } catch (error) {
    next(error);
  }
};

// POST /api/onboarding/:token — the form's submit. Requires explicit terms
// acceptance; the token (not a client-supplied id) is the only identity this
// endpoint trusts. name is optional — the user already gave it in chat
// (see completeNameCollection), this just lets them tweak it while
// confirming; a blank/unchanged field keeps whatever's already on file.
const postOnboarding = async (req, res, next) => {
  try {
    const { name, acceptedTerms } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';

    if (acceptedTerms !== true) {
      return sendError(res, 'You must accept the Terms & Conditions to continue.');
    }
    if (trimmedName && !isValidName(trimmedName)) {
      return sendError(res, 'Please enter a valid name (2-60 characters).');
    }

    const result = await onboardingService.completeRegistration({ token: req.params.token, name: trimmedName || undefined });
    if (!result) return sendError(res, 'This link is invalid or has expired.', 410);

    return sendSuccess(res, {
      name: result.user.preferredName,
      walletAddress: result.wallet.address || result.wallet.publicKey,
    }, 'Registration complete', 201);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOnboarding,
  postOnboarding,
};
