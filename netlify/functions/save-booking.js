// netlify/functions/save-booking.js
//
// Creates the REAL appointment in Square (source of truth for scheduling),
// then logs the extra details Square doesn't track (address, notes,
// add-ons, total charged) to Airtable for your own records.
//
// Expects a POST body like:
// {
//   "variationId":     "WC3VIQCQNLKMAHKRVH5DBGBD",   // from PRICING_DATA on the site
//   "durationMinutes": 150,                            // matches the variation's duration
//   "startAtISO":      "2026-07-20T13:00:00-04:00",    // date+time customer picked, as ISO
//   "firstName": "...", "lastName": "...", "phone": "...", "email": "...",
//   "serviceName": "The Standard", "vehicleLabel": "Coupe / Sedan",
//   "location": "Fairfax, VA", "address": "...", "notes": "...",
//   "addons": "Pet Hair Removal ($29)", "total": 249,
//   "paymentMethod": "card", "paymentReceiptId": "..."
// }

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const {
    variationId, durationMinutes, startAtISO,
    firstName, lastName, phone, email,
    serviceName, vehicleLabel, location, address, notes,
    addons, total, paymentMethod, paymentReceiptId
  } = body;

  if (!variationId || !durationMinutes || !startAtISO || !firstName || !lastName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required booking fields.' }) };
  }

  const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';
  const BASE_URL = SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
  const SQ_HEADERS = {
    'Square-Version': '2024-01-18',
    'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  try {
    // ── Step 1: Find or create the Square Customer ──────────────────
    let customerId = null;

    const searchResp = await fetch(`${BASE_URL}/v2/customers/search`, {
      method: 'POST',
      headers: SQ_HEADERS,
      body: JSON.stringify({
        query: { filter: { email_address: { exact: email } } }
      })
    });
    const searchData = await searchResp.json();
    if (searchData.customers && searchData.customers.length > 0) {
      customerId = searchData.customers[0].id;
    } else {
      const createCustResp = await fetch(`${BASE_URL}/v2/customers`, {
        method: 'POST',
        headers: SQ_HEADERS,
        body: JSON.stringify({
          given_name: firstName,
          family_name: lastName,
          email_address: email,
          phone_number: phone || undefined
        })
      });
      const createCustData = await createCustResp.json();
      if (!createCustResp.ok) {
        console.error('Square customer create error', createCustData);
        return { statusCode: 500, body: JSON.stringify({ error: 'Could not create customer record.', detail: createCustData }) };
      }
      customerId = createCustData.customer.id;
    }

    // ── Step 2: Create the real Square Booking (the appointment) ────
    const bookingResp = await fetch(`${BASE_URL}/v2/bookings`, {
      method: 'POST',
      headers: SQ_HEADERS,
      body: JSON.stringify({
        booking: {
          location_id: process.env.SQUARE_LOCATION_ID,
          start_at: startAtISO,
          customer_id: customerId,
          customer_note: notes || '',
          appointment_segments: [
            {
              team_member_id: process.env.SQUARE_TEAM_MEMBER_ID,
              service_variation_id: variationId,
              duration_minutes: durationMinutes
            }
          ]
        }
      })
    });
    const bookingData = await bookingResp.json();

    if (!bookingResp.ok) {
      console.error('Square booking create error', bookingData);
      // Most common real-world cause: someone else just took this exact
      // slot between the customer viewing availability and submitting.
      return {
        statusCode: bookingResp.status,
        body: JSON.stringify({ error: 'That time is no longer available. Please pick another slot.', detail: bookingData })
      };
    }

    const squareBookingId = bookingData.booking.id;

    // ── Step 3: Log the extra details to Airtable (best-effort) ─────
    // Square doesn't track address/add-ons/etc, so we still keep a row
    // here for your own records. If this part fails, the real Square
    // appointment already exists and is NOT rolled back — we don't want
    // a working booking undone by a secondary logging issue.
    try {
      await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            'First Name': firstName,
            'Last Name': lastName,
            'Phone': phone || '',
            'Email': email,
            'Service': serviceName || '',
            'Vehicle Size': vehicleLabel || '',
            'Add-Ons': addons || 'None',
            'Location': location || '',
            'Address': address || '',
            'Total ($)': total || 0,
            'Payment Method': paymentMethod || '',
            'Payment Receipt': paymentReceiptId || '',
            'Notes': notes || '',
            'Status': paymentMethod === 'card' ? 'Paid' : 'Pending',
            'Square Booking ID': squareBookingId
          }
        })
      });
    } catch (airtableErr) {
      console.error('Airtable logging failed (booking still succeeded)', airtableErr);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, bookingId: squareBookingId })
    };
  } catch (err) {
    console.error('save-booking error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
