// netlify/functions/save-booking.js
//
// Receives the finished booking payload from the frontend and writes it
// to Airtable. This is the only place the Airtable token is used for
// writes — it never ships to the browser. Called AFTER a card charge
// has already succeeded (for card bookings), never before.
//
// Required Netlify environment variables:
//   AIRTABLE_TOKEN   – Airtable personal access token (scoped: this base, read + create only)
//   AIRTABLE_BASE_ID – e.g. appz2DtJwrDFeOVIc
//   AIRTABLE_TABLE   – e.g. Directory

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let fields;
  try {
    fields = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const token  = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table  = process.env.AIRTABLE_TABLE || 'Directory';

  if (!token || !baseId) {
    console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Booking system is not configured yet. Please call us to book directly.' }) };
  }

  // Basic shape check — don't trust the client blindly.
  const required = ['First Name', 'Last Name', 'Phone', 'Email', 'Date', 'Time'];
  for (const key of required) {
    if (!fields[key]) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required field: ' + key }) };
    }
  }

  const url = 'https://api.airtable.com/v0/' + baseId + '/' + encodeURIComponent(table);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: fields })
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      console.error('Airtable write error', data);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: (data.error && data.error.message) || 'Could not save booking.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, id: data.id })
    };
  } catch (err) {
    console.error('save-booking failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Booking save failed.' }) };
  }
};
