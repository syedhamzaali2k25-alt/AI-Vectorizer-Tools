/**
 * Shows the user's current credit balance near the top of any tool
 * page, right where the tool's own cost is already shown ("1 credit
 * per image") — so someone can see at a glance whether they can afford
 * to run it, without needing to go check the dashboard first.
 *
 * Safe to include on every tool page (including the free ones) since it
 * simply does nothing if the user isn't logged in, or if the page
 * doesn't have the expected #credits-remaining-badge element.
 *
 * Only loads once automatically, on page load — after that, it's
 * exposed as window.PixelForgeCreditsBadge.refresh() so each tool's own
 * JS can call it once a job actually completes, instead of the number
 * only ever updating on a full page reload.
 */
(function () {
  const TOKEN_KEY = 'pixelforge_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  async function loadCreditsBadge() {
    const badge = document.getElementById('credits-remaining-badge');
    if (!badge) return; // page doesn't have this element — nothing to do

    const token = getToken();
    if (!token) {
      badge.classList.add('is-hidden');
      return;
    }

    try {
      const res = await fetch('/api/dashboard/me', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        badge.classList.add('is-hidden');
        return;
      }
      const body = await res.json();
      if (body.success) {
        badge.textContent = `${body.user.credits} credits remaining`;
        badge.classList.remove('is-hidden');
      }
    } catch (err) {
      // A failed credit-balance check is a minor, non-blocking nicety —
      // just hide the badge rather than showing an error banner for
      // something this small.
      badge.classList.add('is-hidden');
    }
  }

  window.PixelForgeCreditsBadge = { refresh: loadCreditsBadge };

  loadCreditsBadge();
})();