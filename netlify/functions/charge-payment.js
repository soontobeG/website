// netlify/functions/charge-payment.js
//
// Receives a one-time card token (sourceId) from the Web Payments SDK on
// the frontend and charges it via Square's Payments API. This is the only
// place the real Square Access Token is ever used.
//
// Required Netlify environment variables:
//   SQUARE_ACCESS_TOKEN   – from developer.squareup.com (sandbox or prod)
//   SQUARE_LOCATION_ID    – your Square location ID
//   SQUARE_ENV            – "sandbox" or "production"

const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }

  const { sourceId, amount, buyerEmail } = body;

  if (!sourceId || !amount || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing sourceId or amount' }) };
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId  = process.env.SQUARE_LOCATION_ID;
  const isSandbox   = (process.env.SQUARE_ENV || 'sandbox') === 'sandbox';
  const baseUrl     = isSandbox ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

  if (!accessToken || !locationId) {
    console.error('Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID env vars');
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Payment is not configured yet. Please contact us to complete your booking.' }) };
  }

  // Amount comes in as whole dollars from the frontend; Square wants cents.
  const amountCents = Math.round(Number(amount) * 100);

  try {
    const response = await fetch(`${baseUrl}/v2/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2024-10-17'
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: crypto.randomUUID(),
        amount_money: {
          amount: amountCents,
          currency: 'USD'
        },
        location_id: locationId,
        buyer_email_address: buyerEmail || undefined,
        note: 'CarsPro booking payment'
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const message = (data.errors && data.errors[0] && data.errors[0].detail) || 'Payment was declined.';
      return { statusCode: 200, body: JSON.stringify({ success: false, error: message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        paymentId: data.payment && data.payment.id,
        status: data.payment && data.payment.status
      })
    };
  } catch (err) {
    console.error('Square charge failed', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Payment processor error. Please try again.' }) };
  }
};
