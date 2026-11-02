import { createAnalytics } from "@craftmilldev/analytics/browser";

// POSTHOG_PROJECT_TOKEN and POSTHOG_PROXY_HOST are replaced at build time (build-analytics.mjs).
const analytics = createAnalytics({
  product: "sfml",
  app: "web",
  apiKey: process.env.POSTHOG_PROJECT_TOKEN,
  host: process.env.POSTHOG_PROXY_HOST,
  uiHost: "https://us.posthog.com",
});

document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-posthog-event]");

  if (link) {
    analytics.capture(link.dataset.posthogEvent, {
      link_location: link.dataset.posthogLinkLocation,
      page_path: window.location.pathname,
    });
  }
});
