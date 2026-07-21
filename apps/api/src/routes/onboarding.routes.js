const express = require('express');
const router = express.Router();
const onboardingController = require('../controllers/onboarding.controller');

router.get('/:token', onboardingController.getOnboarding);
router.post('/:token', onboardingController.postOnboarding);

module.exports = router;
