const { isValidName, isValidPin } = require('../utils/validators');
const { sendSuccess, sendError } = require('../utils/response');
const onboardingService = require('../onboarding/onboarding.service');
const webauthnService = require('../onboarding/webauthn.service');

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

// POST /api/onboarding/:token — step 1: name, terms acceptance, and PIN.
// Requires explicit terms acceptance; the token (not a client-supplied id)
// is the only identity this endpoint trusts. name is optional — the user
// already gave it in chat (see completeNameCollection), this just lets them
// tweak it while confirming; a blank/unchanged field keeps whatever's
// already on file. Does not create a wallet — see postCreateWallet.
const postOnboarding = async (req, res, next) => {
  try {
    const { name, acceptedTerms, pin } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';

    if (acceptedTerms !== true) {
      return sendError(res, 'You must accept the Terms & Conditions to continue.');
    }
    if (trimmedName && !isValidName(trimmedName)) {
      return sendError(res, 'Please enter a valid name (2-60 characters).');
    }
    if (!isValidPin(pin)) {
      return sendError(res, 'Please enter a 4-6 digit PIN.');
    }

    const result = await onboardingService.saveSetup({
      token: req.params.token,
      name: trimmedName || undefined,
      acceptedTerms,
      pin,
    });
    if (!result) return sendError(res, 'This link is invalid or has expired.', 410);

    return sendSuccess(res, { name: result.user.preferredName }, 'Setup saved');
  } catch (error) {
    next(error);
  }
};

// GET /api/onboarding/:token/webauthn/register-options — first half of an
// optional passkey enrollment. The browser passes the returned options
// straight into @simplewebauthn/browser's startRegistration().
const getWebauthnRegisterOptions = async (req, res, next) => {
  try {
    const user = await onboardingService.findByRegistrationToken(req.params.token);
    if (!user) return sendError(res, 'This link is invalid or has expired.', 410);

    const options = await webauthnService.generateOptions(user);
    return sendSuccess(res, options);
  } catch (error) {
    next(error);
  }
};

// POST /api/onboarding/:token/webauthn/register — second half: the browser's
// signed attestation, verified against the challenge register-options
// stashed on the user row.
const postWebauthnRegister = async (req, res, next) => {
  try {
    const user = await onboardingService.findByRegistrationToken(req.params.token);
    if (!user) return sendError(res, 'This link is invalid or has expired.', 410);

    await webauthnService.verifyRegistration(user, req.body);
    return sendSuccess(res, null, 'Passkey registered');
  } catch (error) {
    return sendError(res, error.message || 'Passkey registration failed.');
  }
};

// POST /api/onboarding/:token/wallet — the "Create Wallet" button. Only
// reachable once step 1 (postOnboarding) has completed; provisions the
// wallet, burns the token, and sends the WhatsApp confirmation.
const postCreateWallet = async (req, res, next) => {
  try {
    const result = await onboardingService.provisionWallet({ token: req.params.token });
    if (!result) return sendError(res, 'This link is invalid or has expired.', 410);

    return sendSuccess(res, {
      name: result.user.preferredName,
      walletAddress: result.wallet.address || result.wallet.publicKey,
    }, 'Wallet created', 201);
  } catch (error) {
    return sendError(res, error.message || 'Could not create your wallet.');
  }
};

module.exports = {
  getOnboarding,
  postOnboarding,
  getWebauthnRegisterOptions,
  postWebauthnRegister,
  postCreateWallet,
};
