'use strict';

const express = require('express');
const router = express.Router();

const { sendBusinessWelcomeVerified } = require('../utils/emails/businessWelcomeVerified');

router.get('/test-welcome-email', async (req, res) => {
  try {
    const fakeBusiness = {
      name: 'Test Business',
      email: process.env.TEST_TO_EMAIL || 'you@example.com',
      role: 'seller',
      internalBusinessId: 'BIZ-TEST-001',
      officialNumber: '2025/123456/07',
      officialNumberType: 'CIPC',
      verification: { status: 'pending' },
    };

    const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
    const out = await sendBusinessWelcomeVerified(fakeBusiness, baseUrl);

    return res.json({ ok: true, out });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      details: e?.response?.body || e?.response || null,
    });
  }
});

module.exports = router;
