// utils/courierGuy/normalizeCourierGuyRates.js
'use strict';

function clean(value, max = 500) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function extractCourierGuyRates(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.rates)) {
    return data.rates;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  return [];
}

function normalizeCourierGuyRate(rate, index = 0) {
  const raw = rate || {};
  const serviceLevel = raw.service_level || {};

  const serviceLevelId = serviceLevel.id ?? raw.service_level_id ?? raw.serviceLevelId ?? null;

  const serviceCode = serviceLevel.code ?? raw.service_level_code ?? raw.serviceLevelCode ?? '';

  const serviceName =
    serviceLevel.name ??
    raw.service_level_name ??
    raw.serviceLevelName ??
    serviceCode ??
    `Courier Guy service ${index + 1}`;

  const amount = numberOrNull(raw.rate ?? raw.amount ?? raw.total);

  const amountExcludingVat = numberOrNull(raw.rate_excluding_vat ?? raw.amount_excluding_vat);

  const vat = numberOrNull(raw?.base_rate?.vat ?? raw.vat);

  const vatPercentage = numberOrNull(raw?.base_rate?.vat_percentage ?? raw.vat_percentage);

  // Shiplogic/The Courier Guy South African rates are quoted in ZAR.
  // Never relabel a ZAR amount as BASE_CURRENCY without converting it.
  const currency = String(
    raw.currency ||
      raw.currency_code ||
      raw?.base_rate?.currency ||
      raw?.base_rate?.currency_code ||
      'ZAR',
  )
    .trim()
    .toUpperCase();

  if (serviceLevelId === null || amount === null) {
    return null;
  }

  if (!/^[A-Z]{3}$/.test(currency)) {
    return null;
  }

  return {
    providerKey: 'courier_guy',
    providerLabel: 'The Courier Guy',

    rateId: String(serviceLevelId),
    serviceLevelId: String(serviceLevelId),
    serviceCode: clean(serviceCode, 80),
    service: clean(serviceName, 255),

    description: clean(serviceLevel.description || '', 500),

    amount: Number(amount.toFixed(2)),
    amountExcludingVat: amountExcludingVat === null ? null : Number(amountExcludingVat.toFixed(2)),

    currency,

    vat: vat === null ? null : Number(vat.toFixed(2)),

    vatPercentage,

    collectionDate: serviceLevel.collection_date || null,

    collectionCutOffTime: serviceLevel.collection_cut_off_time || null,

    deliveryDateFrom: serviceLevel.delivery_date_from || null,

    deliveryDateTo: serviceLevel.delivery_date_to || null,

    actualWeight: numberOrNull(raw.actual_weight),
    chargedWeight: numberOrNull(raw.charged_weight),
    volumetricWeight: numberOrNull(raw.volumetric_weight),

    extras: Array.isArray(raw.extras) ? raw.extras : [],

    surcharges: Array.isArray(raw.surcharges) ? raw.surcharges : [],

    raw,
  };
}

function normalizeCourierGuyRates(data) {
  return extractCourierGuyRates(data)
    .map(normalizeCourierGuyRate)
    .filter(Boolean)
    .sort((a, b) => a.amount - b.amount);
}

module.exports = {
  extractCourierGuyRates,
  normalizeCourierGuyRate,
  normalizeCourierGuyRates,
};
