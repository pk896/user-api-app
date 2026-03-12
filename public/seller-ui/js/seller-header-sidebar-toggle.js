// user-api-app/public/seller-ui/js/seller-header-sidebar-toggle.js
document.addEventListener('DOMContentLoaded', function () {
  const headerToggleBtn = document.getElementById('seller-header-sidebar-toggle');
  const closeBtn = document.getElementById('seller-sidebar-close-btn');
  const sidebarEl = document.getElementById('sidebar');

  if (!sidebarEl || !window.coreui || !window.coreui.Sidebar) return;

  const getSidebarInstance = () => {
    let sidebarInstance = window.coreui.Sidebar.getInstance(sidebarEl);

    if (!sidebarInstance) {
      sidebarInstance = new window.coreui.Sidebar(sidebarEl);
    }

    return sidebarInstance;
  };

  const toggleSidebar = () => {
    const sidebarInstance = getSidebarInstance();
    sidebarInstance.toggle();
  };

  if (headerToggleBtn) {
    headerToggleBtn.addEventListener('click', function () {
      toggleSidebar();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      toggleSidebar();
    });
  }
});