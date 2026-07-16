// netlify/functions/save-booking.js
//
// Called after payment (if any) has already succeeded. Does two things:
//   1. Creates the real Square Customer (or reuses an existing one by
//      email) and the real Square Booking — this is the actual
//      appointment, and Square itself checks for scheduling conflicts.
//   2. Logs the extra detail Square doesn't track (address, notes,
//      add-ons, payment method) to Airtable, tagged with the Square
//      Booking ID so the two systems can be cross-referenced.
//
// If step 2 fails, the booking created in step 1 still stands — a
// logging hiccup should never undo a real appointment a customer
// already paid for.
//
// Expects (POST body):
//   firstName, lastName, phone, email                  — required
//   variationId, variationVersion, startAtISO           — required (from the
//                                                          package + slot chosen)
//   durationMinutes                                     — optional but recommended
//   vehicleSizeKey, vehicleSizeLabel, vehicleType,
//   package, packageLabel, servicePrice,
//   addons, addonTotal, total,
//   date, time, location, address, notes,
//   paymentMethod, paymentReceiptId, status             — optional detail,
//                                                          logged to Airtable only
//
// Requires these Netlify env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_TEAM_MEMBER_ID, SQUARE_ENV
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE

const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';
const SQUARE_BASE_URL = SQUARE_ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

function squareHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Square-Version': '2024-01-18',
  };
}

async function findOrCreateCustomer({ firstName, lastName, phone, email }) {
  // Search first — avoids creating duplicate customer records for repeat
  // clients booking again with the same email.
  const searchRes = await fetch(`${SQUARE_BASE_URL}/v2/customers/search`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({
      query: { filter: { email_address: { exact: email } } },
    }),
  });
  const searchData = await searchRes.json();
  if (searchRes.ok && searchData.customers && searchData.customers.length > 0) {
    return searchData.customers[0].id;
  }

  const createRes = await fetch(`${SQUARE_BASE_URL}/v2/customers`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({
      given_name: firstName,
      family_name: lastName,
      email_address: email,
      phone_number: phone,
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) {
    throw new Error('Square customer creation failed: ' + JSON.stringify(createData));
  }
  return createData.customer.id;
}

async function createSquareBooking({ customerId, variationId, variationVersion, durationMinutes, startAtISO, notes }) {
  const idempotencyKey = `${startAtISO}-${variationId}-${Date.now()}`;

  const segment = {
    team_member_id: process.env.SQUARE_TEAM_MEMBER_ID,
    service_variation_id: variationId,
    // Square requires this to match the exact catalog version the
    // variation was at when it was fetched. Without it, booking
    // creation fails with "service_variation_version required" — this
    // was the root cause of the earlier errors.
    service_variation_version: variationVersion,
  };
  if (durationMinutes) segment.duration_minutes = durationMinutes;

  const bookingRes = await fetch(`${SQUARE_BASE_URL}/v2/bookings`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      booking: {
        location_id: process.env.SQUARE_LOCATION_ID,
        start_at: startAtISO,
        customer_id: customerId,
        customer_note: notes || '',
        appointment_segments: [segment],
      },
    }),
  });
  const bookingData = await bookingRes.json();
  if (!bookingRes.ok) {
    const err = new Error('Square booking creation failed: ' + JSON.stringify(bookingData));
    err.squareResponse = bookingData;
    throw err;
  }
  return bookingData.booking;
}

async function logToAirtable(body, squareBookingId) {
  const addonStr = Array.isArray(body.addons) && body.addons.length > 0
    ? body.addons.map((a) => `${a.name} ($${a.price})`).join(', ')
    : 'None';

  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
    },
    body: JSON.stringify({
      fields: {
        'First Name': body.firstName,
        'Last Name': body.lastName,
        Phone: body.phone,
        Email: body.email,
        Package: body.packageLabel || '',
        'Vehicle Size': body.vehicleSizeLabel || '',
        'Vehicle Type': body.vehicleType || '',
        'Add-Ons': addonStr,
        Date: body.date || '',
        Time: body.time || '',
        Location: body.location || '',
        Address: body.address || '',
        'Total ($)': body.total || 0,
        'Payment Method': body.paymentMethod || '',
        'Payment Receipt': body.paymentReceiptId || '',
        Notes: body.notes || '',
        Status: body.status || 'Pending',
        'Square Booking ID': squareBookingId || '',
      },
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    console.error('Airtable logging failed (booking still stands):', errData);
    return { ok: false, error: errData };
  }
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // NOTE: variationVersion is required (this is the fix). Checked with
  // a custom test below instead of the blanket !body[k] check, since a
  // legitimate version number or duration could in theory be 0/falsy.
  const required = ['firstName', 'lastName', 'phone', 'email', 'variationId', 'variationVersion', 'startAtISO'];
  const missing = required.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length > 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }),
    };
  }

  try {
    const customerId = await findOrCreateCustomer(body);
    const booking = await createSquareBooking({
      customerId,
      variationId: body.variationId,
      variationVersion: body.variationVersion,
      durationMinutes: body.durationMinutes,
      startAtISO: body.startAtISO,
      notes: body.notes,
    });

    // Airtable logging is best-effort — failures here are logged but
    // never override the fact that a real booking now exists in Square.
    const airtableResult = await logToAirtable(body, booking.id).catch((e) => {
      console.error('Airtable logging threw:', e);
      return { ok: false, error: e.message };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        bookingId: booking.id,
        booking,
        airtableLogged: airtableResult.ok,
      }),
    };
  } catch (err) {
    console.error('save-booking error', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
