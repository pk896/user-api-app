// middleware/storeDepartment.js
'use strict';

function normalizeDepartment(value) {
  return String(value || '').trim().toLowerCase() === 'cj'
    ? 'cj'
    : 'internal';
}

function cartSummary(cart) {
  const items = Array.isArray(cart?.items)
    ? cart.items
    : [];

  return items.reduce(
    (summary, item) => {
      const quantity = Math.max(
        0,
        Math.floor(Number(item?.quantity || 0)),
      );

      const price = Number(item?.price || 0);

      summary.count += quantity;
      summary.total +=
        (Number.isFinite(price) ? price : 0) * quantity;

      return summary;
    },
    {
      count: 0,
      total: 0,
    },
  );
}

module.exports = function storeDepartment(req, res, next) {
  const activeDepartment = normalizeDepartment(
    req.session?.storeDepartment,
  );

  const internalCart = cartSummary(
    req.session?.cart,
  );

  const cjCart = cartSummary(
    req.session?.cjCart,
  );

  res.locals.storeDepartment = activeDepartment;

  res.locals.internalCartSummary = {
    count: internalCart.count,
    total: Number(internalCart.total.toFixed(2)),
  };

  res.locals.cjCartSummary = {
    count: cjCart.count,
    total: Number(cjCart.total.toFixed(2)),
  };

  res.locals.activeStoreCart =
    activeDepartment === 'cj'
      ? res.locals.cjCartSummary
      : res.locals.internalCartSummary;

  res.locals.activeStoreCartUrl =
    activeDepartment === 'cj'
      ? '/cj/cart'
      : '/store/cart';

  next();
};
