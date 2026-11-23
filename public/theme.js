// Runs before first paint so a saved theme never flashes the wrong colours.
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage can be blocked; the system theme still applies */ }
