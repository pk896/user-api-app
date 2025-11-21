// utils/logger.js
const TZ = 'Africa/Johannesburg';

function safe(obj) {
  try {
    return JSON.stringify(
      obj,
      (k, v) => {
        // Print Dates as ISO and local for visibility
        if (v instanceof Date) {
          return {
            __type: 'Date',
            iso: v.toISOString(),
            local: v.toLocaleString('en-ZA', { timeZone: TZ }),
            epochMs: v.getTime(),
          };
        }
        return v;
      },
      2,
    );
  } catch (e) {
    return String(obj);
  }
}

function stamp() {
  const now = new Date();
  return `${now.toISOString()} [${now.toLocaleString('en-ZA', { timeZone: TZ })}]`;
}

function log(scope, msg, obj) {
  const head = `${stamp()} :: ${scope} :: ${msg}`;
  if (obj === undefined) {
    console.log(head);
  } else {
    console.log(head + '\n' + safe(obj));
  }
}

module.exports = { log, TZ };
