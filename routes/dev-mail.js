// routes/dev-mail.js
const express = require('express');
const { sendMail } = require('../utils/mailer');
const router = express.Router();

router.get('/dev/test-mail', async (req, res) => {
  try {
    await sendMail({
      to: 'phakisingxongxela@gmail.com', // or any address you can check
      subject: '✅ Phakisi SendGrid test',
      text: 'Your SendGrid setup works!',
      html: '<strong>Your SendGrid setup works!</strong>'
    });
    res.send('✅ Mail sent. Check your inbox/spam.');
  } catch (e) {
    res.status(500).send('❌ Mail failed: ' + (e.message || e));
  }
});

module.exports = router;
