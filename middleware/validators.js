// middleware/validators.js
const { body } = require('express-validator');
const { isSafeHttpUrl } = require('../utils/safeUrl');

const urlField = (field, { restrictToHosts = null, requirePublicIP = false } = {}) =>
  body(field)
    .optional({ checkFalsy: true })
    .bail()
    .custom(async (val) => {
      const { ok, reason } = await isSafeHttpUrl(val, {
        allowedHosts: restrictToHosts ? new Set(restrictToHosts) : null,
        requirePublicIP,
      });
      if (!ok) {throw new Error(`Invalid or unsafe URL (${reason})`);}
      return true;
    });

module.exports = { urlField };
