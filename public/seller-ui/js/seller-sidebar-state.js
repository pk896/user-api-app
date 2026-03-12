(async function () {
  const img = document.getElementById('seller-avatar');
  if (img) {
    if (window.__SELLER_AVATAR__) {
      img.src = window.__SELLER_AVATAR__;
    } else {
      img.src = '/images/branding/logo-unincorporate.png';
    }
  }

  const verifiedOnlyItems = document.querySelectorAll('.seller-verified-only');
  const unverifiedNotes = document.querySelectorAll('.seller-unverified-note');

  const showVerifiedState = (isVerified) => {
    if (!isVerified) {
      verifiedOnlyItems.forEach((el) => el.classList.add('d-none'));
      unverifiedNotes.forEach((el) => el.classList.remove('d-none'));
    } else {
      verifiedOnlyItems.forEach((el) => el.classList.remove('d-none'));
      unverifiedNotes.forEach((el) => el.classList.add('d-none'));
    }
  };

  try {
    const res = await fetch('/business/api/session/sidebar-state', {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      showVerifiedState(false);
      return;
    }

    const data = await res.json();

    if (!data || data.ok !== true || !data.business) {
      showVerifiedState(false);
      return;
    }

    showVerifiedState(data.business.isVerified === true);
  } catch (err) {
    console.error('Failed to load sidebar state:', err);
    showVerifiedState(false);
  }
})();