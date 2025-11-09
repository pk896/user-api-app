const express = require('express');
const { sendMail } = require('../utils/mailer');
const router = express.Router();

router.get('/dev/test-mail', async (req, res) => {
  try {
    const to = req.query.to || 'phakisingxongxela@gmail.com';
    await sendMail({
      to,
      subject: '✅ Phakisi SendGrid test',
      text: 'Your SendGrid setup works!',
      html: '<strong>Your SendGrid setup works!</strong>'
    });
    res.send('✅ Mail sent. Check your inbox/spam.');
  } catch (e) {
    console.error('[dev/test-mail] error:', e);
    res.status(500).send('❌ Mail failed: ' + (e.response?.body?.errors?.[0]?.message || e.message || e));
  }
});

module.exports = router;
