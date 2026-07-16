// netlify/functions/check-availability.js
//
// Given a ?date= query param, returns the list of already-booked times
// for that date. This is the only place the Airtable token is used for
// reads — it never ships to the browser.
//
// Required Netlify environment variables:
//   AIRTABLE_TOKEN   – Airtable personal access token (scoped: this base, read-only is enough here)
//   AIRTABLE_BASE_ID – e.g. appz2DtJwrDFeOVIc
//   AIRTABLE_TABLE   – e.g. Directory

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const dateStr = event.queryStringParameters && event.queryStringParameters.date;
  if (!dateStr) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing date parameter' }) };
  }

  const token   = process.env.AIRTABLE_TOKEN;
  const baseId  = process.env.AIRTABLE_BASE_ID;
  const table   = process.env.AIRTABLE_TABLE || 'Directory';

  if (!token || !baseId) {
    console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Availability check is not configured yet.' }) };
  }

  const url = 'https://api.airtable.com/v0/' + baseId + '/' + encodeURIComponent(table);
  const filter = encodeURIComponent("AND({Date}='" + dateStr + "',{Status}!='Cancelled')");

  try {
    const resp = await fetch(url + '?filterByFormula=' + filter + '&fields[]=Time', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await resp.json();

    if (!resp.ok) {
      console.error('Airtable error', data);
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not load availability.' }) };
    }

    const times = (data.records || [])
      .map(function (rec) { return rec.fields && rec.fields.Time; })
      .filter(Boolean);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookedTimes: times })
    };
  } catch (err) {
    console.error('check-availability failed', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Availability check failed.' }) };
  }
};
