(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const authGate = document.getElementById('auth-gate');
  const dashboardContent = document.getElementById('dashboard-content');
  const errorBanner = document.getElementById('error-banner');

  const dashboardHeading = document.getElementById('dashboard-heading');
  const dashEmail = document.getElementById('dash-email');
  const dashPlan = document.getElementById('dash-plan');
  const dashCredits = document.getElementById('dash-credits');

  const usageTbody = document.getElementById('usage-tbody');
  const creditTbody = document.getElementById('credit-tbody');

  const apiKeySection = document.getElementById('api-key-section');
  const apiKeyGenerateBtn = document.getElementById('api-key-generate-btn');
  const apiKeyRevokeBtn = document.getElementById('api-key-revoke-btn');
  const apiKeyDisplay = document.getElementById('api-key-display');
  const apiKeyValue = document.getElementById('api-key-value');
  const apiKeyCopyBtn = document.getElementById('api-key-copy-btn');
  const apiKeyNote = document.getElementById('api-key-note');

  function getToken() { return localStorage.getItem(TOKEN_KEY); }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('is-hidden');
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function toolDisplayName(tool) {
    const names = {
      'bg-remove': 'Background Remover',
      'upscale': 'Image Upscaler',
      'watermark-remove': 'Watermark Remover',
      'expand': 'Image Expander'
    };
    return names[tool] || tool;
  }

  async function authedFetch(path, options) {
    const token = getToken();
    const res = await fetch(path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options && options.headers) }
    });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      authGate.classList.remove('is-hidden');
      dashboardContent.classList.add('is-hidden');
      showError('Your session expired. Please sign in again.');
      throw new Error('Unauthorized');
    }
    return res.json();
  }

  function renderUsageTable(history) {
    if (!history.length) {
      usageTbody.innerHTML = '<tr><td colspan="5" class="dash-empty">No tools used yet — try one from the homepage!</td></tr>';
      return;
    }
    usageTbody.innerHTML = history.map((row) => {
      const statusClass = row.status === 'completed' ? 'dash-status-completed' : 'dash-status-failed';
      const outputLink = (row.status === 'completed' && row.output_url)
        ? `<a href="${row.output_url}" target="_blank" rel="noopener">View</a>`
        : '—';
      return `<tr>
        <td>${toolDisplayName(row.tool)}</td>
        <td><span class="dash-status ${statusClass}">${capitalize(row.status)}</span></td>
        <td>${row.credits_used}</td>
        <td>${formatDate(row.created_at)}</td>
        <td>${outputLink}</td>
      </tr>`;
    }).join('');
  }

  function renderCreditTable(history) {
    if (!history.length) {
      creditTbody.innerHTML = '<tr><td colspan="4" class="dash-empty">No credit activity yet.</td></tr>';
      return;
    }
    creditTbody.innerHTML = history.map((row) => {
      const isPositive = row.amount > 0;
      const amountClass = isPositive ? 'dash-amount-positive' : 'dash-amount-negative';
      const amountText = isPositive ? `+${row.amount}` : `${row.amount}`;
      const reasonText = row.reason.replace(/_/g, ' ');
      return `<tr>
        <td class="${amountClass}">${amountText}</td>
        <td>${capitalize(reasonText)}</td>
        <td>${row.balance_after}</td>
        <td>${formatDate(row.created_at)}</td>
      </tr>`;
    }).join('');
  }

  /**
   * API key section is Business-plan-only — only shown at all once we
   * know the user's actual plan, and only wired up (fetching current
   * key status) for Business users specifically, so Free/Pro accounts
   * never even attempt a request that would just come back 403.
   */
  async function initApiKeySection(planName) {
    if (planName !== 'business') return;

    apiKeySection.classList.remove('is-hidden');

    try {
      const body = await authedFetch('/api/api-key');
      if (body.success && body.hasKey) {
        apiKeyRevokeBtn.style.display = 'inline-flex';
        apiKeyGenerateBtn.textContent = 'Generate new key (replaces current)';
        apiKeyDisplay.style.display = 'block';
        apiKeyValue.textContent = body.maskedKey;
        apiKeyCopyBtn.style.display = 'none'; // masked key isn't useful to copy
        const expiryText = body.expiresAt ? ` Expires ${new Date(body.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.` : '';
        apiKeyNote.textContent = `A key already exists. The full value is only shown once, right when it's generated.${expiryText}`;
      }
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        showError('Could not load your API key status.');
      }
    }
  }

  apiKeyGenerateBtn.addEventListener('click', async () => {
    const confirmMsg = apiKeyRevokeBtn.style.display !== 'none'
      ? 'This replaces your current key — anything using the old one will stop working. Continue?'
      : null;
    if (confirmMsg && !window.confirm(confirmMsg)) return;

    try {
      const body = await authedFetch('/api/api-key/generate', { method: 'POST' });
      if (!body.success) {
        showError(body.error || 'Could not generate an API key.');
        return;
      }
      apiKeyDisplay.style.display = 'block';
      apiKeyValue.textContent = body.apiKey;
      apiKeyCopyBtn.style.display = 'inline-flex';
      const expiryText = body.expiresAt ? ` Expires in 30 days, on ${new Date(body.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.` : '';
      apiKeyNote.textContent = `Copy this now — it will only be shown this once. Refreshing this page will show a masked version instead.${expiryText}`;
      apiKeyRevokeBtn.style.display = 'inline-flex';
      apiKeyGenerateBtn.textContent = 'Generate new key (replaces current)';
    } catch (err) {
      if (err.message !== 'Unauthorized') showError('Could not generate an API key. Try again.');
    }
  });

  apiKeyCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(apiKeyValue.textContent);
      const original = apiKeyCopyBtn.textContent;
      apiKeyCopyBtn.textContent = 'Copied!';
      setTimeout(() => { apiKeyCopyBtn.textContent = original; }, 1500);
    } catch (err) {
      showError('Could not copy automatically — select and copy the key manually.');
    }
  });

  apiKeyRevokeBtn.addEventListener('click', async () => {
    if (!window.confirm('Revoke your API key? Anything using it will stop working immediately.')) return;
    try {
      const body = await authedFetch('/api/api-key', { method: 'DELETE' });
      if (!body.success) {
        showError(body.error || 'Could not revoke the key.');
        return;
      }
      apiKeyDisplay.style.display = 'none';
      apiKeyRevokeBtn.style.display = 'none';
      apiKeyGenerateBtn.textContent = 'Generate new key';
    } catch (err) {
      if (err.message !== 'Unauthorized') showError('Could not revoke the key. Try again.');
    }
  });

  async function loadDashboard() {
    try {
      const meBody = await authedFetch('/api/dashboard/me');
      if (!meBody.success) { showError(meBody.error || 'Could not load your account.'); return; }

      dashEmail.textContent = meBody.user.email;
      const displayName = meBody.user.full_name || meBody.user.email.split('@')[0];
      dashboardHeading.textContent = `Hey, ${displayName}`;
      dashPlan.textContent = capitalize(meBody.user.plan_name) + ' plan';
      dashCredits.textContent = `${meBody.user.credits} / ${meBody.user.plan_monthly_credits} per month`;

      initApiKeySection(meBody.user.plan_name);

      const [usageBody, creditBody] = await Promise.all([
        authedFetch('/api/dashboard/usage-history'),
        authedFetch('/api/dashboard/credit-history')
      ]);

      if (usageBody.success) renderUsageTable(usageBody.history);
      if (creditBody.success) renderCreditTable(creditBody.history);
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        const isNetworkFailure = err instanceof TypeError && err.message.toLowerCase().includes('fetch');
        showError(isNetworkFailure
          ? 'Could not reach the server. Check your connection and try again.'
          : `Something went wrong loading the dashboard: ${err.message}`);
      }
    }
  }

  function showUpgradeSuccessIfRedirected() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') !== 'true') return;

    const banner = document.createElement('div');
    banner.style.cssText = 'max-width:900px; margin:0 auto 24px; padding:16px 20px; border-radius:14px; background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.3); color:#22C55E; font-size:14px;';
    banner.textContent = "Payment received! Your plan is being updated — this usually takes just a few seconds. Refresh if it doesn't show up right away.";
    dashboardContent.parentElement.insertBefore(banner, dashboardContent);

    // Clean the query param out of the URL so refreshing later doesn't
    // keep re-showing this banner for what's already a stale event.
    const url = new URL(window.location.href);
    url.searchParams.delete('upgraded');
    window.history.replaceState({}, '', url);
  }

  function init() {
    if (!getToken()) {
      dashboardContent.classList.add('is-hidden');
      authGate.classList.remove('is-hidden');
      return;
    }
    authGate.classList.add('is-hidden');
    dashboardContent.classList.remove('is-hidden');
    showUpgradeSuccessIfRedirected();
    loadDashboard();
  }

  init();
})();