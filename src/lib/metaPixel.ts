// Meta (Facebook) pixel — ads conversion tracking. The pixel ID is public by nature
// (it ships in page source on every site that uses one); the base code only initialises
// on the production hosts (see components/MetaPixel.tsx), so window.fbq is undefined on
// localhost/previews and every helper here no-ops.
export const META_PIXEL_ID = "4681723008724913";
export const META_PIXEL_HOSTS = ["onside.com.ng", "www.onside.com.ng"];

type Fbq = (...args: unknown[]) => void;
declare global {
  interface Window {
    fbq?: Fbq;
  }
}

// standard Meta events (CompleteRegistration, …)
export function pixelTrack(event: string, params?: Record<string, unknown>) {
  window.fbq?.("track", event, params);
}

// custom events (FirstSlipUpload) — these are what the ad campaign optimises on
export function pixelTrackCustom(event: string, params?: Record<string, unknown>) {
  window.fbq?.("trackCustom", event, params);
}
