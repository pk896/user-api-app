// utils/payment/shippoCreateCustomsDeclaration.js
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
    Product, // ✅ received from routes/payment.js
  } = deps;

  if (!Product) {
    const err = new Error('Product model is required for customs declaration.');
    err.code = 'NO_PRODUCT_MODEL';
    throw err;
  }

  const pairs = await loadProductsForCart(cart, { Product });
  validateCartProductsShippingOrThrow(pairs);

  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  if (!itemsArr.length) {
    const err = new Error('Cart is empty; cannot create customs declaration.');
    err.code = 'CART_EMPTY';
    throw err;
  }

  /*
   * Customs item origin means the country where the product was
   * manufactured or produced.
   *
   * It is NOT:
   * - the pickup warehouse country;
   * - the customer's destination country;
   * - SHIPPO_FROM_COUNTRY.
   *
   * This dedicated fallback is used only when an older product
   * does not yet have a valid madeCode.
   */
  const defaultProductOriginCountry =
    normalizeCountryCode(envStr('SHIPPO_DEFAULT_PRODUCT_ORIGIN_COUNTRY', 'ZA')) || 'ZA';
  const currency = upperCcy;
  const massUnit = 'kg';

  function clip(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max) : s;
  }

  const exporterRef = (() => {
    const pref = 'UNIC';
    const dest = clip(toCountry ? String(toCountry).toUpperCase() : 'XX', 2);
    const ts = Math.floor(Date.now() / 1000);
    return clip(`${pref}-${dest}-${ts}`, 20);
  })();

  const signer = envStr('SHIPPO_FROM_NAME', BRAND_NAME_N) || BRAND_NAME_N;

  const items = pairs.map((row, i) => {
    const product = row.product;
    const cartItem = row.cartItem;

    const quantity = toQty(cartItem?.qty ?? cartItem?.quantity, 1);

    const name = String(product?.name || cartItem?.name || cartItem?.title || `Item ${i + 1}`)
      .trim()
      .slice(0, 50);

    const unitValue = normalizeMoneyNumber(cartItem?.price ?? cartItem?.unitPrice) ?? 0;

    const totalValue = Number((Number(unitValue) * quantity).toFixed(2));

    const shipping = product?.shipping || {};

    const kgEach = kgFrom(shipping?.weight?.value, shipping?.weight?.unit);

    const totalKg = Number((kgEach * quantity).toFixed(3));

    /*
     * Product.madeCode is stored lowercase in MongoDB,
     * so normalizeCountryCode() converts it safely to the
     * uppercase two-letter code required by Shippo.
     */
    const productOriginCountry =
      normalizeCountryCode(product?.madeCode) || defaultProductOriginCountry;

    return {
      description: name,

      quantity,

      net_weight: String(Math.max(0.001, totalKg)),

      mass_unit: massUnit,

      value_amount: String(Math.max(0, totalValue)),

      value_currency: currency,

      origin_country: productOriginCountry,
    };
  });

  const rawEelPfc =
    typeof getShippoEelPfc === 'function' ? String(getShippoEelPfc() || '').trim() : '';

  const eelPfc = rawEelPfc || 'NOEEI_30_37_a'; // ✅ hard fallback (never empty)

  const payload = {
    certify: true,
    certify_signer: String(signer).slice(0, 100),
    contents_type: 'MERCHANDISE',
    non_delivery_option: 'RETURN',
    incoterm: 'DDU',
    eel_pfc: eelPfc,
    exporter_reference: exporterRef,
    items,
  };

  const customsItemOrigins = [
    ...new Set(
      payload.items.map((item) => normalizeCountryCode(item?.origin_country)).filter(Boolean),
    ),
  ];

  console.log('[Shippo customs payload]', {
    eel_pfc: payload.eel_pfc,

    exporter_reference: payload.exporter_reference,

    itemsCount: Array.isArray(payload.items) ? payload.items.length : 0,

    itemOrigins: customsItemOrigins,

    defaultProductOriginCountry,

    toCountry: normalizeCountryCode(toCountry),
  });

  const res = await fetchWithTimeout(
    `${SHIPPO_API}/customs/declarations/`,
    {
      method: 'POST',
      headers: shippoHeaders(),
      body: JSON.stringify(payload),
    },
    SHIPPO_TIMEOUT_MS,
  );

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      Array.isArray(json?.messages) && json.messages.length
        ? JSON.stringify(json.messages)
        : json?.detail || json?.message || JSON.stringify(json);
    const err = new Error(`Shippo customs declaration error (${res.status}): ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_FAILED';
    throw err;
  }

  const status = String(json?.object_status || '').toUpperCase();
  if (status && status !== 'SUCCESS') {
    const msg =
      Array.isArray(json?.messages) && json.messages.length
        ? JSON.stringify(json.messages)
        : json?.detail || json?.message || JSON.stringify(json);
    const err = new Error(`Shippo customs declaration object_status=${status}: ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_OBJECT_ERROR';
    throw err;
  }

  const id = json?.object_id ? String(json.object_id) : null;
  if (!id) throw new Error('Shippo customs declaration did not return object_id.');
  return id;
}

module.exports = { shippoCreateCustomsDeclaration };
