const express = require('express');
const router = express.Router();
const onboardingController = require('../controllers/onboarding.controller');

router.get('/:token', onboardingController.getOnboarding);
router.post('/:token', onboardingController.postOnboarding);
router.get('/:token/webauthn/register-options', onboardingController.getWebauthnRegisterOptions);
router.post('/:token/webauthn/register', onboardingController.postWebauthnRegister);
router.post('/:token/wallet', onboardingController.postCreateWallet);

module.exports = router;
