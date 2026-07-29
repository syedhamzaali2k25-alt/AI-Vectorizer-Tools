const express = require('express');
const authController = require('../controllers/authController');
const googleAuthController = require('../controllers/googleAuthController');

const router = express.Router();

router.post('/signup', authController.signup);
router.post('/login', authController.login);

router.get('/google', googleAuthController.redirectToGoogle);
router.get('/google/callback', googleAuthController.handleCallback);

module.exports = router;