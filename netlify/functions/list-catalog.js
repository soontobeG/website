// TEMPORARY helper — lists your Square Catalog items and their variation IDs
// so we can map "The Standard / SUV" etc. to real Square IDs.
// Delete this file once you've copied the output — it's not meant to stay live.
exports.handler = async function (event) {
  const SQUARE_ENV = process.env.SQUARE_ENV || 'sandbox';
  const BASE_URL = SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
  try {
    const resp = await fetch(`${BASE_URL}/v2/catalog/list?types=ITEM`, {
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify(data) };
    }
    // Flatten into a readable summary: item name -> each variation name + id
    const summary = (data.objects || []).map(function (item) {
      const variations = (item.item_data.variations || []).map(function (v) {
        return {
          variation_name: v.item_variation_data.name,
          variation_id: v.id,
          // Required by Square's booking API (service_variation_version)
          // for strict catalog-version matching. This is the field that
          // was missing and causing "service_variation_version required"
          // errors on every booking attempt.
          variation_version: v.version,
          duration_ms: v.item_variation_data.service_duration || null,
          price: v.item_variation_data.price_money || null
        };
      });
      return {
        item_name: item.item_data.name,
        item_id: item.id,
        variations: variations
      };
    });
    // Also fetch locations
    const locResp = await fetch(`${BASE_URL}/v2/locations`, {
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    const locData = await locResp.json();
    const locations = (locData.locations || []).map(function (l) {
      return { name: l.name, id: l.id, status: l.status };
    });
    // Also fetch team members (Bookings needs Team Member Booking Profiles)
    const teamResp = await fetch(`${BASE_URL}/v2/bookings/team-member-booking-profiles`, {
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    const teamData = await teamResp.json();
    const teamMembers = (teamData.team_member_booking_profiles || []).map(function (t) {
      return { display_name: t.display_name, team_member_id: t.team_member_id };
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalog: summary, locations: locations, teamMembers: teamMembers }, null, 2)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
