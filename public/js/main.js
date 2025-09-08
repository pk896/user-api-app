// Get the theme button
/*const themeBtn = document.getElementById('theme-toggle-btn');

themeBtn?.addEventListener('click', async () => {
  try {
    // Call backend route to toggle theme in session
    const res = await fetch('/theme-toggle', { method: 'POST' });
    const data = await res.json();

    // Update themeCss dynamically
    const linkTag = document.querySelector('link[rel=stylesheet]');
    if (linkTag) {
      if (data.theme === 'dark') {
        linkTag.href = '/css/dark.css';
      } else {
        linkTag.href = '/css/light.css';
      }
    }
  } catch (err) {
    console.error('Theme toggle error:', err);
  }
});*/













document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('theme-toggle-btn');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/theme-toggle', { method: 'POST' });
      const data = await res.json();
      console.log('Theme switched to:', data.theme);

      // Reload page to apply new theme CSS
      location.reload();
    } catch (err) {
      console.error('Error toggling theme:', err);
    }
  });
});

// ------------------ main.js ------------------
document.addEventListener("DOMContentLoaded", () => {
    const themeBtn = document.getElementById("theme-toggle-btn");

    // Load saved theme from sessionStorage
    if (sessionStorage.getItem("theme") === "dark") {
        document.body.classList.add("dark");
        themeBtn.textContent = "Go to Light Theme Screen";
    } else {
        themeBtn.textContent = "Go to Dark Theme Screen";
    }

    // Toggle theme on button click
    themeBtn.addEventListener("click", () => {
        document.body.classList.toggle("dark");
        const isDark = document.body.classList.contains("dark");

        // Update sessionStorage
        sessionStorage.setItem("theme", isDark ? "dark" : "light");

        // Update button text
        themeBtn.textContent = isDark ? "Go to Light Theme Screen" : "Go to Dark Theme Screen";
    });
});