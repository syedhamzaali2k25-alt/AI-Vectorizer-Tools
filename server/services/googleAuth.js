/**
 * Google OAuth 2.0 — Authorization Code flow (server-side, confidential
 * client, since we hold a client_secret — this is the standard flow for
 * traditional web apps like ours, not the PKCE/implicit flows meant for
 * SPAs or mobile apps that can't keep a secret safe).
 *
 * Endpoints (confirmed from Google's current docs):
 *   Authorization: https://accounts.google.com/o/oauth2/v2/auth
 *   Token exchange: https://oauth2.googleapis.com/token
 *   Userinfo (OIDC standard): https://openidconnect.googleapis.com/v1/userinfo
 *
 * We verify the user's identity by calling the userinfo endpoint with the
 * access token we get back from Google — not by decoding/verifying the ID
 * token's JWT signature ourselves. This is simpler (no JWKS/RSA
 * verification code needed) and still secure: the profile data comes
 * straight from Google's servers over HTTPS using a token only we
 * received via the authorization code exchange.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function getGoogleAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account'
  });
  if (state) params.set('state', state);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForProfile(code, { clientId, clientSecret, redirectUri }, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;

  const tokenRes = await doFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Google token exchange failed (${tokenRes.status}): ${text.slice(0, 300)}`);
  }
  const tokenBody = await tokenRes.json();

  if (!tokenBody.access_token) {
    throw new Error('Google token response did not include an access_token');
  }

  const userRes = await doFetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenBody.access_token}` }
  });

  if (!userRes.ok) {
    const text = await userRes.text().catch(() => '');
    throw new Error(`Google userinfo request failed (${userRes.status}): ${text.slice(0, 300)}`);
  }

  const profile = await userRes.json();
  // profile: { sub, email, email_verified, name, picture, ... }
  return profile;
}

module.exports = { getGoogleAuthUrl, exchangeCodeForProfile };