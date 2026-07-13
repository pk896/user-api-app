// utils/cj/cjTrackingService.js
'use strict';

const CjOrder = require('../../models/CjOrder');

const { cjRequest } = require('./cjClient');

const { sendCjOrderEventEmailsSafely } = require('./cjOrderEmailService');

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const clean = safeString(value, 2000);

    if (clean) {
      return clean;
    }
  }

  return '';
}

function responseData(response) {
  if (response?.data && typeof response.data === 'object') {
    return response.data;
  }

  return response || {};
}

function normalizeStatus(value) {
  const raw = safeString(value, 200)
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (!raw) {
    return '';
  }

  if (
    raw.includes('OUT_FOR_DELIVERY') ||
    raw.includes('DELIVERING') ||
    raw.includes('WITH_COURIER')
  ) {
    return 'OUT_FOR_DELIVERY';
  }

  if (raw.includes('DELIVERED') || raw === 'SIGNED') {
    return 'DELIVERED';
  }

  if (raw.includes('RETURN') || raw.includes('RETURNED_TO_SENDER')) {
    return 'RETURNED';
  }

  if (raw.includes('CANCEL') || raw.includes('CLOSED')) {
    return 'CANCELLED';
  }

  if (
    raw.includes('TRANSIT') ||
    raw.includes('DEPARTED') ||
    raw.includes('ARRIVED') ||
    raw.includes('CUSTOMS') ||
    raw.includes('LINEHAUL')
  ) {
    return 'IN_TRANSIT';
  }

  if (raw.includes('SHIPPED') || raw.includes('DISPATCHED') || raw.includes('FULFILLED')) {
    return 'SHIPPED';
  }

  if (
    raw.includes('PROCESS') ||
    raw.includes('PICKING') ||
    raw.includes('PACKING') ||
    raw.includes('PREPARING') ||
    raw.includes('PENDING')
  ) {
    return 'PROCESSING';
  }

  if (raw.includes('FAIL')) {
    return 'FAILED';
  }

  return '';
}

function getCjOrderStatus(data) {
  return firstNonEmpty(
    data?.status,
    data?.orderStatus,
    data?.order_status,
    data?.cjOrderStatus,
    data?.orderState,
  );
}

function getTrackingNumber(data) {
  const packages = Array.isArray(data?.packages)
    ? data.packages
    : Array.isArray(data?.packageList)
      ? data.packageList
      : [];

  return firstNonEmpty(
    data?.trackingNumber,
    data?.trackNumber,
    data?.trackingNum,
    data?.logisticTrackNumber,
    data?.logisticsTrackingNumber,
    packages?.[0]?.trackingNumber,
    packages?.[0]?.trackNumber,
  );
}

function getTrackingUrl(data) {
  return firstNonEmpty(data?.trackingUrl, data?.trackUrl, data?.logisticsTrackingUrl);
}

function getCarrierName(data) {
  return firstNonEmpty(
    data?.carrierName,
    data?.logisticName,
    data?.logisticsName,
    data?.shippingName,
  );
}

function getEstimatedDelivery(data) {
  return safeDate(
    data?.estimatedDelivery ||
      data?.estimatedDeliveryTime ||
      data?.deliveryTime ||
      data?.expectedDeliveryTime,
  );
}

function normalizeLocation(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return safeString(value, 500);
  }

  return [value?.city, value?.state, value?.province, value?.country]
    .map((entry) => safeString(entry, 200))
    .filter(Boolean)
    .join(', ');
}

function extractTrackingRows(data) {
  const candidates = [
    data?.events,
    data?.trackingEvents,
    data?.trackList,
    data?.trackingList,
    data?.logisticsTrackList,
    data?.list,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function normalizeTrackingEvents(data) {
  return extractTrackingRows(data)
    .map((row) => {
      const description = firstNonEmpty(
        row?.description,
        row?.details,
        row?.message,
        row?.remark,
        row?.context,
        row?.status,
      );

      const rawStatus = firstNonEmpty(row?.status, row?.trackStatus, row?.eventStatus, description);

      const occurredAt = safeDate(
        row?.occurredAt ||
          row?.date ||
          row?.time ||
          row?.timestamp ||
          row?.createTime ||
          row?.eventTime,
      );

      return {
        status: normalizeStatus(rawStatus) || safeString(rawStatus, 100),
        description,
        location: normalizeLocation(row?.location || row?.place || row?.address),
        occurredAt,
      };
    })
    .filter((event) => event.status || event.description || event.occurredAt)
    .sort((left, right) => {
      return Number(new Date(left.occurredAt || 0)) - Number(new Date(right.occurredAt || 0));
    })
    .slice(-100);
}

function mergeTrackingEvents(existingEvents, incomingEvents) {
  const map = new Map();

  for (const event of [
    ...(Array.isArray(existingEvents) ? existingEvents : []),

    ...(Array.isArray(incomingEvents) ? incomingEvents : []),
  ]) {
    const key = [
      safeString(event?.status, 100),
      safeString(event?.description, 1000),
      safeString(event?.location, 500),
      event?.occurredAt ? new Date(event.occurredAt).toISOString() : '',
    ].join('|');

    map.set(key, {
      status: safeString(event?.status, 100),
      description: safeString(event?.description, 2000),
      location: safeString(event?.location, 500),
      occurredAt: safeDate(event?.occurredAt),
    });
  }

  return [...map.values()]
    .sort((left, right) => {
      return Number(new Date(left.occurredAt || 0)) - Number(new Date(right.occurredAt || 0));
    })
    .slice(-100);
}

function statusRank(status) {
  const ranks = {
    PENDING: 0,
    PROCESSING: 1,
    SHIPPED: 2,
    IN_TRANSIT: 3,
    OUT_FOR_DELIVERY: 4,
    DELIVERED: 5,
  };

  return ranks[status] ?? -1;
}

function chooseProgressStatus(currentStatus, incomingStatus) {
  const current = safeString(currentStatus, 100).toUpperCase();

  const incoming = safeString(incomingStatus, 100).toUpperCase();

  if (!incoming) {
    return current || 'PENDING';
  }

  if (['CANCELLED', 'RETURNED', 'FAILED'].includes(incoming)) {
    return incoming;
  }

  if (['CANCELLED', 'RETURNED'].includes(current)) {
    return current;
  }

  return statusRank(incoming) >= statusRank(current) ? incoming : current;
}

function orderStatusFromTracking(status) {
  const normalized = safeString(status, 100).toUpperCase();

  if (['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'].includes(normalized)) {
    return normalized;
  }

  if (['IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(normalized)) {
    return 'SHIPPED';
  }

  return '';
}

async function fetchCjOrderDetail(order) {
  const cjOrderId = firstNonEmpty(
    order?.supplierOrder?.cjOrderId,
    order?.supplierOrder?.cjOrderNumber,
  );

  if (!cjOrderId) {
    const error = new Error('CJ supplier order ID is missing.');

    error.code = 'CJ_TRACKING_ORDER_ID_MISSING';

    throw error;
  }

  const pathname = safeString(
    process.env.CJ_ORDER_DETAIL_PATH || '/shopping/order/getOrderDetail',
    500,
  );

  return cjRequest(pathname, {
    method: 'GET',

    query: {
      orderId: cjOrderId,
    },
  });
}

async function fetchCjLogisticsTrack(trackingNumber) {
  const cleanTrackingNumber = safeString(trackingNumber, 300);

  if (!cleanTrackingNumber) {
    return null;
  }

  const pathname = safeString(process.env.CJ_TRACK_INFO_PATH || '/logistic/trackInfo', 500);

  return cjRequest(pathname, {
    method: 'GET',

    query: {
      trackNumber: cleanTrackingNumber,
    },
  });
}

async function syncCjTrackingForOrderId(orderId, { source = 'manual' } = {}) {
  const order = await CjOrder.findOne({
    _id: orderId,
    department: 'CJ',
  });

  if (!order) {
    return {
      ok: false,
      reason: 'CJ_ORDER_NOT_FOUND',
    };
  }

  if (String(order?.supplierOrder?.createStatus || '').toUpperCase() !== 'SUCCESS') {
    return {
      ok: true,
      skipped: true,
      reason: 'CJ_SUPPLIER_ORDER_NOT_CREATED',
      cjOrderNumber: order.cjOrderNumber,
    };
  }

  const previousStatus = safeString(order?.tracking?.status, 100).toUpperCase() || 'PENDING';

  const orderDetailResponse = await fetchCjOrderDetail(order);

  const orderData = responseData(orderDetailResponse);

  const detailTrackingNumber = getTrackingNumber(orderData);

  const trackingNumber =
    detailTrackingNumber ||
    safeString(order?.tracking?.trackingNumber || order?.supplierOrder?.trackingNumber, 300);

  let trackingResponse = null;
  let trackingData = {};

  if (trackingNumber) {
    trackingResponse = await fetchCjLogisticsTrack(trackingNumber);

    trackingData = responseData(trackingResponse);
  }

  const orderDetailStatus = normalizeStatus(getCjOrderStatus(orderData));

  const logisticsStatus = normalizeStatus(
    firstNonEmpty(
      trackingData?.status,
      trackingData?.trackStatus,
      trackingData?.logisticsStatus,
      trackingData?.latestStatus,
      trackingData?.trackingStatus,
    ),
  );

  const incomingStatus = logisticsStatus || orderDetailStatus || previousStatus;

  const nextStatus = chooseProgressStatus(previousStatus, incomingStatus);

  const incomingEvents = normalizeTrackingEvents(trackingData);

  if (trackingNumber) {
    order.tracking.trackingNumber = trackingNumber;

    order.supplierOrder.trackingNumber = trackingNumber;
  }

  const trackingUrl = getTrackingUrl(trackingData) || getTrackingUrl(orderData);

  if (trackingUrl) {
    order.tracking.trackingUrl = trackingUrl;

    order.supplierOrder.trackingUrl = trackingUrl;
  }

  const carrierName =
    getCarrierName(trackingData) ||
    getCarrierName(orderData) ||
    safeString(order?.selectedShipping?.logisticsName, 300);

  if (carrierName) {
    order.tracking.carrierName = carrierName;

    order.supplierOrder.logisticsName = carrierName;
  }

  const estimatedDelivery = getEstimatedDelivery(trackingData) || getEstimatedDelivery(orderData);

  if (estimatedDelivery) {
    order.tracking.estimatedDelivery = estimatedDelivery;
  }

  if (incomingEvents.length) {
    order.tracking.events = mergeTrackingEvents(order?.tracking?.events, incomingEvents);
  }

  order.tracking.status = nextStatus;
  order.tracking.lastSyncedAt = new Date();
  order.tracking.lastError = '';

  order.supplierOrder.lastSyncedAt = new Date();

  const matchingOrderStatus = orderStatusFromTracking(nextStatus);

  if (matchingOrderStatus) {
    order.fulfillmentStatus = nextStatus;

    order.status = matchingOrderStatus;
  }

  await order.save();

  if (nextStatus !== previousStatus) {
    await sendCjOrderEventEmailsSafely(order, nextStatus, {
      source: `cj-tracking:${source}`,
    });
  }

  return {
    ok: true,
    cjOrderNumber: order.cjOrderNumber,
    previousStatus,
    status: nextStatus,
    changed: previousStatus !== nextStatus,
    trackingNumber: order.tracking.trackingNumber,
    orderRequestId: safeString(orderDetailResponse?.requestId, 200),
    trackingRequestId: safeString(trackingResponse?.requestId, 200),
  };
}

async function recordTrackingFailure(orderId, error) {
  await CjOrder.updateOne(
    {
      _id: orderId,
      department: 'CJ',
    },
    {
      $set: {
        'tracking.lastSyncedAt': new Date(),

        'tracking.lastError': safeString(error?.message || error, 2000),
      },
    },
  );
}

module.exports = {
  normalizeStatus,
  normalizeTrackingEvents,
  syncCjTrackingForOrderId,
  recordTrackingFailure,
};
