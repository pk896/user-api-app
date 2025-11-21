// utils/routeWrap.js
const { log } = require('./logger');

const wrap = (scope, handler) => async (req, res, next) => {
  try {
    log(scope, 'ENTER', {
      method: req.method,
      url: req.originalUrl,
      query: req.query,
      params: req.params,
    });
    await handler(req, res, next);
    log(scope, 'EXIT OK', { statusCode: res.statusCode });
  } catch (err) {
    log(scope, 'EXIT ERROR', {
      name: err.name,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
    });
    next(err);
  }
};

module.exports = { wrap };
