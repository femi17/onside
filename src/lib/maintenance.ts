// App-wide maintenance notice. Flip `on` to false the moment the data feed is back (Oct 11) to hide the
// banner everywhere. Keep the message honest and specific — transparency is what keeps an outage from
// reading as fraud: say what's degraded, confirm bets still settle, and name the goodwill given.
export const MAINTENANCE = {
  on: true,
  message:
    "Heads up: our results feed is on maintenance until Oct 11. New scores and bet results are paused for now — everything catches up and settles the moment we're back, so nothing is lost. We've added 11 free days to every active subscription. Thanks for bearing with us.",
};

// Pause NEW paid checkouts during the outage — we don't take fresh money for a degraded service.
// Flip to false when the feed is back (~Oct 11). Existing members keep full access.
export const CHECKOUT_FROZEN = true;
export const CHECKOUT_FROZEN_MESSAGE =
  "New subscriptions are paused until Oct 11 while our results feed is on maintenance — we don't want you paying for a degraded service. Everyone already subscribed keeps full access and got 11 free days added. Please check back on Oct 11.";
