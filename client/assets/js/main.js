document.addEventListener('DOMContentLoaded', () => {
  // FAQ accordion — only one open at a time
  document.querySelectorAll('.faq-item').forEach((item) => {
    const question = item.querySelector('.faq-question');
    question.addEventListener('click', () => {
      const wasOpen = item.classList.contains('is-open');
      document.querySelectorAll('.faq-item.is-open').forEach((el) => el.classList.remove('is-open'));
      if (!wasOpen) item.classList.add('is-open');
    });
  });

  // Mobile menu toggle
  const toggle = document.getElementById('menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  const navActions = document.querySelector('.nav-actions');
  // Remember exactly where nav-actions came from, so it can be restored
  // to its original position (not just hidden) once the mobile dropdown
  // closes — otherwise moving it once would permanently break the
  // desktop flex layout for the rest of the session.
  const navActionsOriginalNextSibling = navActions ? navActions.nextSibling : null;
  const navActionsOriginalParent = navActions ? navActions.parentElement : null;
  let mobileMenuOpen = false;

  function closeMobileMenu() {
    mobileMenuOpen = false;
    navLinks.style.display = 'none';
    if (navActions && navActionsOriginalParent) {
      navActions.removeAttribute('style');
      navActionsOriginalParent.insertBefore(navActions, navActionsOriginalNextSibling);
    }
  }

  if (toggle && navLinks) {
    toggle.addEventListener('click', () => {
      if (mobileMenuOpen) {
        closeMobileMenu();
        return;
      }
      mobileMenuOpen = true;
      navLinks.style.cssText = 'display:flex; position:absolute; top:70px; left:24px; right:24px; flex-direction:column; gap:16px; background:rgba(15,17,23,0.95); padding:24px; border-radius:16px; border:1px solid rgba(255,255,255,0.08); z-index:50;';

      // nav-actions (login/signup, or dashboard/avatar/logout once signed
      // in) is hidden entirely on mobile via CSS — without this, those
      // actions would be completely unreachable on small screens.
      if (navActions) {
        navActions.style.cssText = 'display:flex; flex-direction:column; gap:10px; width:100%; margin-top:4px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.08);';
        navLinks.appendChild(navActions);
      }
    });

    // If the window gets resized back to desktop width while the mobile
    // menu happens to be open, reset everything rather than leaving
    // nav-actions stranded inside nav-links at a width where it should
    // have been a normal flex sibling again.
    window.addEventListener('resize', () => {
      if (mobileMenuOpen && window.innerWidth > 980) closeMobileMenu();
    });
  }

  // Nav auth state — swap "Log in / Sign up" for an avatar + logout button
  // when a token exists. Only runs on pages that actually have this nav
  // structure (currently just the homepage) — safe no-op elsewhere.
  const TOKEN_KEY = 'pixelforge_token';
  const navLoginBtn = document.getElementById('nav-login-btn');
  const navSignupBtn = document.getElementById('nav-signup-btn');
  const navUser = document.getElementById('nav-user');
  const navAvatar = document.getElementById('nav-avatar');
  const navLogoutBtn = document.getElementById('nav-logout-btn');

  function decodeJwtPayload(token) {
    try {
      const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(base64));
    } catch (err) {
      return null; // malformed/garbage token pasted manually — treat as not logged in
    }
  }

  if (navLoginBtn && navSignupBtn && navUser && navAvatar) {
    const token = localStorage.getItem(TOKEN_KEY);
    const payload = token ? decodeJwtPayload(token) : null;

    if (payload && payload.email) {
      navLoginBtn.classList.add('is-hidden');
      navSignupBtn.classList.add('is-hidden');
      navUser.classList.remove('is-hidden');
      navAvatar.textContent = payload.email.charAt(0).toUpperCase();
      navAvatar.title = payload.email;
    }
  }

  if (navLogoutBtn) {
    navLogoutBtn.addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = '/';
    });
  }
});