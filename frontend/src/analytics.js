// Google Analytics (GA4) + Hotjar — both are no-ops unless their env var is set, so
// local dev never sends real traffic data and nothing breaks if an ID is missing.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const HOTJAR_ID = import.meta.env.VITE_HOTJAR_SITE_ID;

function loadGoogleAnalytics(id) {
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id);
}

function loadHotjar(siteId) {
  window.hj = window.hj || function () { (window.hj.q = window.hj.q || []).push(arguments); };
  window._hjSettings = { hjid: Number(siteId), hjsv: 6 };
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://static.hotjar.com/c/hotjar-${siteId}.js?sv=6`;
  document.head.appendChild(script);
}

export function initAnalytics() {
  if (GA_ID) {
    loadGoogleAnalytics(GA_ID);
  } else if (import.meta.env.DEV) {
    console.info('[analytics] VITE_GA_MEASUREMENT_ID not set — Google Analytics disabled.');
  }

  if (HOTJAR_ID) {
    loadHotjar(HOTJAR_ID);
  } else if (import.meta.env.DEV) {
    console.info('[analytics] VITE_HOTJAR_SITE_ID not set — Hotjar disabled.');
  }
}
