// public/seller-ui/js/business-avatar.js
(function () {
  const avatarEl = document.getElementById('seller-avatar');
  if (!avatarEl) return;

  const fallbackLogo = '/images/branding/logo-unincorporate.png';
  function applyAvatar(src, businessName) {
    avatarEl.src = src || fallbackLogo;
    avatarEl.alt = businessName
      ? `${businessName} logo`
      : 'Seller account';
    avatarEl.setAttribute('title', businessName || 'Seller account');

    const breadcrumbEl = document.getElementById('seller-breadcrumb-name');
    if (breadcrumbEl && businessName) {
      breadcrumbEl.textContent = businessName;
    }
  }
  
  async function loadBusinessAvatar() {
    try {
      const res = await fetch('/business/api/logo', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        applyAvatar(fallbackLogo, '');
        return;
      }

      const data = await res.json();

      if (!data || data.success !== true || !data.business) {
        applyAvatar(fallbackLogo, '');
        return;
      }

      const logoUrl = String(data.business.logoUrl || '').trim();
      const businessName = String(data.business.name || '').trim();

      if (logoUrl) {
        applyAvatar(logoUrl, businessName);
      } else {
        applyAvatar(fallbackLogo, businessName);
      }
    } catch (err) {
      console.error('❌ Failed to load business avatar:', err);
      applyAvatar(fallbackLogo, '');
    }
  }

  avatarEl.onerror = function () {
    this.onerror = null;
    applyAvatar(fallbackLogo, '');
  };

  loadBusinessAvatar();
})();
