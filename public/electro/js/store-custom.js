// public/electro/js/store-custom.js
document.addEventListener('DOMContentLoaded', () => {
  const rangeInput = document.getElementById('rangeInput');
  const amount = document.getElementById('amount');

  if (rangeInput && amount) {
    amount.value = rangeInput.value;
    amount.textContent = rangeInput.value;

    rangeInput.addEventListener('input', () => {
      amount.value = rangeInput.value;
      amount.textContent = rangeInput.value;
    });
  }

  const hideStoreProductActionsOnScroll = () => {
    document.body.classList.add('store-is-scrolling');

    if (
      document.activeElement &&
      typeof document.activeElement.blur === 'function' &&
      document.activeElement.closest('.js-store-product-card')
    ) {
      document.activeElement.blur();
    }

    window.clearTimeout(window.storeProductScrollTimer);

    window.storeProductScrollTimer = window.setTimeout(() => {
      document.body.classList.remove('store-is-scrolling');
    }, 150);
  };

  window.addEventListener('scroll', hideStoreProductActionsOnScroll, { passive: true });
  window.addEventListener('touchmove', hideStoreProductActionsOnScroll, { passive: true });
  window.addEventListener('wheel', hideStoreProductActionsOnScroll, { passive: true });
});