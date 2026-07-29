(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const errorBanner = document.getElementById('error-banner');
  const submitBtn = document.getElementById('submit-btn');

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('is-hidden');
  }
  function clearError() {
    errorBanner.classList.add('is-hidden');
  }

  if (localStorage.getItem(TOKEN_KEY)) {
    window.location.href = '/';
  }

  // Google sign-in redirects back here with ?error=... if something went
  // wrong (cancelled, config missing, etc.) — surface it the same way a
  // normal login error would show.
  const urlError = new URLSearchParams(window.location.search).get('error');
  if (urlError) showError(urlError);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in…';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const body = await res.json();

      if (!body.success) {
        showError(body.error || 'Invalid email or password.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log in';
        return;
      }

      localStorage.setItem(TOKEN_KEY, body.token);
      window.location.href = '/';
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
    }
  });
})();