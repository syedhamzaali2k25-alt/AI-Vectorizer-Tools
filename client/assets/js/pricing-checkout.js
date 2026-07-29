(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const proBtn = document.getElementById('plan-pro-btn');
  const businessBtn = document.getElementById('plan-business-btn');
  const errorBanner = document.getElementById('pricing-error-banner');

  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('is-hidden');
  }

  /**
   * Starting a paid plan requires an account first — Lemon Squeezy's
   * checkout needs to know who to attach the subscription to. If the
   * person isn't logged in yet, send them to sign up rather than
   * failing silently or showing a confusing error; once they have an
   * account they can come back and click the plan button again.
   */
  async function startCheckout(planName, button) {
    const token = getToken();
    if (!token) {
      window.location.href = '/signup';
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Loading…';

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planName })
      });

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        window.location.href = '/signup';
        return;
      }

      const body = await res.json();
      if (!body.success) {
        showError(body.error || 'Could not start checkout. Try again.');
        button.disabled = false;
        button.textContent = originalText;
        return;
      }

      // Hand off to Lemon Squeezy's own hosted checkout page — the
      // actual card entry, tax handling, and payment happen there, not
      // on this site.
      window.location.href = body.checkoutUrl;
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  if (proBtn) {
    proBtn.addEventListener('click', () => startCheckout(proBtn.dataset.plan, proBtn));
  }
  if (businessBtn) {
    businessBtn.addEventListener('click', () => startCheckout(businessBtn.dataset.plan, businessBtn));
  }
})();