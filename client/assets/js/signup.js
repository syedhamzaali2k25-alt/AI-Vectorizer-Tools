(function () {
  const TOKEN_KEY = 'pixelforge_token';

  const form = document.getElementById('signup-form');
  const fullNameInput = document.getElementById('full-name');
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

  // If already logged in, no reason to see the signup form
  if (localStorage.getItem(TOKEN_KEY)) {
    window.location.href = '/';
  }

  const urlError = new URLSearchParams(window.location.search).get('error');
  if (urlError) showError(urlError);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const fullName = fullNameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (password.length < 8) {
      showError('Password must be at least 8 characters.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, fullName: fullName || undefined })
      });

      const body = await res.json();

      if (!body.success) {
        showError(body.error || 'Could not create your account. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }

      localStorage.setItem(TOKEN_KEY, body.token);
      window.location.href = '/';
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
})();