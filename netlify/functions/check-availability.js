// netlify/functions/check-availability.js
//
// Asks Square's Bookings API directly: "for this service variation, on this
// date, what times are actually open?" Square handles all conflict-checking
// itself — no more manual Airtable row-scanning, no date-format mismatches.
//
// Expects: GET /.netlify/functions/check-availability?date=YYYY-MM-DD&variationId=XXXX
//   date        — ISO format, e.g. "2026-07-20"
//   variationId — the Square service variation ID for the chosen package + vehicle size
//
// Returns: { availableTimes: ["9:00 AM", "1:00 PM", ...] }

exports.handler = async function (event) {
  const { date, variationId } = event.queryStringParameters || {};

  if (!date || !variationId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required "date" or "variationId" query parameter.' })
    };
  }

  const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';
  const BASE_URL = SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  // Search the whole calendar day, in UTC. Square wants a start/end range.
  const startAt = `${date}T00:00:00Z`;
  const endAt   = `${date}T23:59:59Z`;

  try {
    const resp = await fetch(`${BASE_URL}/v2/bookings/availability/search`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          filter: {
            location_id: process.env.SQUARE_LOCATION_ID,
            start_at_range: { start_at: startAt, end_at: endAt },
            segment_filters: [
              {
                service_variation_id: variationId,
                team_member_id_filter: {
                  any: [process.env.SQUARE_TEAM_MEMBER_ID]
                }
              }
            ]
          }
        }
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Square availability search error', data);
      return { statusCode: resp.status, body: JSON.stringify({ error: data }) };
    }

    // Square returns full ISO timestamps for each open slot. Keep the raw
    // timestamp AND a "9:00 AM" display label — the frontend shows the
    // label but sends the raw timestamp back verbatim when it books,
    // so there's no risk of a timezone mismatch on the way back in.
    const availableTimes = (data.availabilities || []).map(function (slot) {
      const d = new Date(slot.start_at);
      const label = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
      });
      return { time: label, startAt: slot.start_at };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ availableTimes: availableTimes })
    };
  } catch (err) {
    console.error('check-availability error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
