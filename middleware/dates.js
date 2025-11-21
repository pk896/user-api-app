// middleware/dates.js
const { TZ } = require('../utils/logger');

function attachDateHelpers(req, res, next) {
  res.locals.fmtDate = (d, opts = {}) => {
    if (!d) {return '';}
    try {
      const date = d instanceof Date ? d : new Date(d);
      const style = opts.style || 'medium'; // 'full' | 'long' | 'medium' | 'short'
      const time = opts.time ?? true;
      return date.toLocaleString('en-ZA', {
        timeZone: TZ,
        dateStyle: style,
        ...(time ? { timeStyle: 'short' } : {}),
      });
    } catch {
      return String(d);
    }
  };
  next();
}

module.exports = { attachDateHelpers };
