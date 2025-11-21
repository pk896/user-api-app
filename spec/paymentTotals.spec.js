// spec/paymentTotals.spec.js
const { computeTotalsFromSession } = require('../routes/payment');

describe('computeTotalsFromSession', () => {
  it('calculates subtotal, VAT and grand total correctly', () => {
    const cart = {
      items: [
        { name: 'apple',  price: 3, quantity: 2 }, // 6
        { name: 'banana', price: 4, quantity: 1 }, // 4
      ],
    };

    const delivery = 10; // shipping
    const result = computeTotalsFromSession(cart, delivery);

    // subtotal = 10
    expect(result.subTotal).toBeCloseTo(10);

    // assuming VAT_RATE = 0.15
    expect(result.vatTotal).toBeCloseTo(1.5);

    // delivery
    expect(result.delivery).toBeCloseTo(10);

    // grand = 10 + 1.5 + 10 = 21.5
    expect(result.grandTotal).toBeCloseTo(21.5);
  });
});
