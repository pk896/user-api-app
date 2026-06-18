// utils/courierGuy/normalizeCourierGuyShipment.js
'use strict';

function text(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ''
    ) {
      return value;
    }
  }

  return null;
}

function firstUrl(...values) {
  const value = firstValue(...values);

  const url = text(value, 2000);

  return /^https?:\/\//i.test(url) ? url : '';
}

function unwrap(data) {
  if (!data || typeof data !== 'object') {
    return {};
  }

  if (Array.isArray(data)) {
    return data[0] || {};
  }

  if (Array.isArray(data?.shipments)) {
    return data.shipments[0] || {};
  }

  if (Array.isArray(data?.data)) {
    return data.data[0] || {};
  }

  if (Array.isArray(data?.results)) {
    return data.results[0] || {};
  }

  return (
    data.shipment ||
    data.data?.shipment ||
    data.data ||
    data.result ||
    data
  );
}

function extractParcelWaybills(source) {
  const shipment = unwrap(source);

  const candidates = [
    shipment.parcel_waybills,
    shipment.parcelWaybills,
    shipment.parcels,
    source?.parcel_waybills,
    source?.parcelWaybills,
    source?.shipment?.parcel_waybills,
    source?.shipment?.parcelWaybills,
    source?.data?.parcel_waybills,
    source?.data?.parcelWaybills,
  ];

  const rows = candidates.find(Array.isArray) || [];

  return rows
    .map((parcel) => {
      const parcelReference = text(
        firstValue(
          parcel?.parcel_reference,
          parcel?.parcelReference,
          parcel?.waybill_number,
          parcel?.waybillNumber,
          parcel?.tracking_reference,
          parcel?.trackingReference,
        ),
        200,
      );

      return {
        parcelReference,

        waybillNumber: text(
          firstValue(
            parcel?.waybill_number,
            parcel?.waybillNumber,
            parcelReference,
          ),
          200,
        ),

        trackingReference: text(
          firstValue(
            parcel?.tracking_reference,
            parcel?.trackingReference,
            parcelReference,
          ),
          200,
        ),
      };
    })
    .filter((parcel) => {
      return Boolean(
        parcel.parcelReference ||
          parcel.waybillNumber ||
          parcel.trackingReference,
      );
    });
}

function normalizeStatus(value) {
  const raw = text(value, 120)
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (['DELIVERED', 'COMPLETED'].includes(raw)) {
    return 'DELIVERED';
  }

  if (
    ['CANCELLED', 'CANCELED', 'VOIDED', 'DELETED'].includes(raw)
  ) {
    return 'CANCELLED';
  }

  if (
    ['OUT_FOR_DELIVERY', 'ON_DELIVERY'].includes(raw)
  ) {
    return 'OUT_FOR_DELIVERY';
  }

  if (
    [
      'IN_TRANSIT',
      'TRANSIT',
      'COLLECTED',
      'AT_HUB',
      'LINEHAUL',
    ].includes(raw)
  ) {
    return 'IN_TRANSIT';
  }

  if (
    ['SHIPPED', 'DISPATCHED', 'DESPATCHED'].includes(raw)
  ) {
    return 'SHIPPED';
  }

  if (
    [
      'CREATED',
      'BOOKED',
      'READY',
      'PENDING',
      'PROCESSING',
      'COLLECTION_ASSIGNED',
    ].includes(raw)
  ) {
    return raw || 'PROCESSING';
  }

  return raw || 'PROCESSING';
}

function normalizeEvents(source) {
  const shipment = unwrap(source);

  const candidates = [
    shipment.events,
    shipment.tracking_events,
    shipment.tracking_history,
    shipment.history,
    source?.events,
    source?.tracking_events,
  ];

  const rawEvents = candidates.find(Array.isArray) || [];

  return rawEvents.map((event) => ({
    status: normalizeStatus(
      firstValue(
        event.status,
        event.event_status,
        event.state,
        event.type,
      ),
    ),

    rawStatus: text(
      firstValue(
        event.status,
        event.event_status,
        event.state,
        event.type,
      ),
      120,
    ),

    details: text(
      firstValue(
        event.description,
        event.details,
        event.message,
        event.comment,
      ),
      500,
    ),

    date: firstValue(
      event.date,
      event.datetime,
      event.event_datetime,
      event.status_date,
      event.created_at,
      event.updated_at,
      event.timestamp,
    ),

    location:
      event.location ||
      {
        city: text(
          firstValue(
            event.city,
            event.location_city,
          ),
          120,
        ),

        state: text(
          firstValue(
            event.zone,
            event.province,
            event.state,
          ),
          120,
        ),

        country: text(
          firstValue(
            event.country,
            event.country_code,
          ),
          2,
        ),
      },
  }));
}

function normalizeCourierGuyShipment(data) {
  const shipment = unwrap(data);

  const parcelWaybills = extractParcelWaybills(data);

  const firstParcelWaybill =
    parcelWaybills.find((parcel) => parcel?.waybillNumber) || {};

  const shipmentId = text(
    firstValue(
      shipment.id,
      shipment.shipment_id,
      shipment.shipmentId,
      shipment.uuid,
      data?.shipment_id,
    ),
    200,
  );

  const trackingReference = text(
    firstValue(
      shipment.tracking_reference,
      shipment.trackingReference,

      shipment.custom_tracking_reference,
      shipment.customTrackingReference,

      shipment.tracking_number,
      shipment.trackingNumber,

      shipment.waybill_number,
      shipment.waybillNumber,

      firstParcelWaybill.trackingReference,
    ),
    200,
  );

  const shortTrackingReference = text(
    firstValue(
      shipment.short_tracking_reference,
      shipment.shortTrackingReference,
      shipment.short_reference,
    ),
    200,
  );

  const waybillNumber = text(
    firstValue(
      shipment.waybill_number,
      shipment.waybillNumber,
      shipment.waybill_reference,
      shipment.waybillReference,
      shipment.waybill,

      firstParcelWaybill.waybillNumber,
      firstParcelWaybill.parcelReference,
    ),
    200,
  );

  const status = normalizeStatus(
    firstValue(
      shipment.status,
      shipment.shipment_status,
      shipment.state,
      shipment.tracking_status,
    ),
  );

  const events = normalizeEvents(data);

  const latestEvent =
    events.length > 0
      ? events[events.length - 1]
      : null;

  return {
    shipmentId,

    trackingReference,
    shortTrackingReference,

    waybillNumber,
    parcelWaybills,

    waybillUrl: firstUrl(
      shipment.waybill_url,
      shipment.waybillUrl,
      shipment.documents?.waybill,
      shipment.links?.waybill,
    ),

    labelUrl: firstUrl(
      shipment.label_url,
      shipment.labelUrl,
      shipment.documents?.label,
      shipment.links?.label,
    ),

    stickerUrl: firstUrl(
      shipment.sticker_url,
      shipment.stickerUrl,
      shipment.documents?.sticker,
      shipment.links?.sticker,
    ),

    trackingUrl: firstUrl(
      shipment.tracking_url,
      shipment.trackingUrl,
      shipment.links?.tracking,
    ),

    status,
    events,

    estimatedDelivery: firstValue(
      shipment.estimated_delivery,
      shipment.estimatedDelivery,
      shipment.delivery_date,
      shipment.expected_delivery_date,
    ),

    lastUpdate: firstValue(
      latestEvent?.date,
      shipment.updated_at,
      shipment.updatedAt,
      shipment.modified_at,
      new Date().toISOString(),
    ),

    raw: data,
  };
}

module.exports = {
  normalizeCourierGuyShipment,
  normalizeCourierGuyStatus: normalizeStatus,
};