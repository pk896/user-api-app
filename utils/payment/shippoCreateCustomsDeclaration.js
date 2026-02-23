'use strict';

async function shippoCreateCustomsDeclaration({ cart, toCountry }, deps = {}) {
  const {
    loadProductsForCart,
    validateCartProductsShippingOrThrow,
    normalizeCountryCode,
    envStr,
    upperCcy,
    BRAND_NAME_N,
    toQty,
    normalizeMoneyNumber,
    kgFrom,
    getShippoEelPfc,
    fetchWithTimeout,
    SHIPPO_API,
    shippoHeaders,
    SHIPPO_TIMEOUT_MS,
  } = deps;

  const pairs = await loadProductsForCart(cart);
  validateCartProductsShippingOrThrow(pairs);

  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  if (!itemsArr.length) {
    const err = new Error('Cart is empty; cannot create customs declaration.');
    err.code = 'CART_EMPTY';
    throw err;
  }

  const originCountry = normalizeCountryCode(envStr('SHIPPO_FROM_COUNTRY', 'ZA')) || 'ZA';
  const currency = upperCcy;
  const massUnit = 'kg';

  function clip(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max) : s;
  }

  const exporterRef = (() => {
    const pref = 'UNIC';
    const dest = clip((toCountry ? String(toCountry).toUpperCase() : 'XX'), 2);
    const ts = Math.floor(Date.now() / 1000);
    return clip(`${pref}-${dest}-${ts}`, 20);
  })();

  const signer = envStr('SHIPPO_FROM_NAME', BRAND_NAME_N) || BRAND_NAME_N;

  const items = pairs.map((row, i) => {
    const p = row.product;
    const it = row.cartItem;

    const qty = toQty(it?.qty ?? it?.quantity, 1);

    const name = String(p?.name || it?.name || it?.title || `Item ${i + 1}`).slice(0, 50);

    const unitVal = normalizeMoneyNumber(it?.price ?? it?.unitPrice) ?? 0;
    const totalVal = +(Number(unitVal) * qty).toFixed(2);

    const sh = p?.shipping || {};
    const kgEach = kgFrom(sh?.weight?.value, sh?.weight?.unit);
    const totalKg = +(kgEach * qty).toFixed(3);

    return {
      description: name,
      quantity: qty,
      net_weight: String(Math.max(0.001, totalKg)),
      mass_unit: massUnit,
      value_amount: String(Math.max(0, totalVal)),
      value_currency: currency,
      origin_country: originCountry,
    };
  });

  const payload = {
    certify: true,
    certify_signer: String(signer).slice(0, 100),
    contents_type: 'MERCHANDISE',
    non_delivery_option: 'RETURN',
    incoterm: 'DDU',
    eel_pfc: getShippoEelPfc(),
    exporter_reference: exporterRef,
    items,
  };

  const res = await fetchWithTimeout(
    `${SHIPPO_API}/customs/declarations/`,
    {
      method: 'POST',
      headers: shippoHeaders(),
      body: JSON.stringify(payload),
    },
    SHIPPO_TIMEOUT_MS
  );

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      (Array.isArray(json?.messages) && json.messages.length)
        ? JSON.stringify(json.messages)
        : (json?.detail || json?.message || JSON.stringify(json));
    const err = new Error(`Shippo customs declaration error (${res.status}): ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_FAILED';
    throw err;
  }

  const status = String(json?.object_status || '').toUpperCase();
  if (status && status !== 'SUCCESS') {
    const msg =
      (Array.isArray(json?.messages) && json.messages.length)
        ? JSON.stringify(json.messages)
        : (json?.detail || json?.message || JSON.stringify(json));
    const err = new Error(`Shippo customs declaration object_status=${status}: ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_OBJECT_ERROR';
    throw err;
  }

  const id = json?.object_id ? String(json.object_id) : null;
  if (!id) throw new Error('Shippo customs declaration did not return object_id.');
  return id;
}

module.exports = { shippoCreateCustomsDeclaration };