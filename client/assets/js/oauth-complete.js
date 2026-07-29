(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    localStorage.setItem('pixelforge_token', token);
    window.location.href = '/';
  } else {
    window.location.href = '/login?error=' + encodeURIComponent('Sign-in did not complete. Please try again.');
  }
})();