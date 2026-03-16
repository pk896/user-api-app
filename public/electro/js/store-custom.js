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
});