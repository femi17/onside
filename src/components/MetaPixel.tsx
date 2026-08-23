"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { META_PIXEL_ID, META_PIXEL_HOSTS } from "@/lib/metaPixel";

// Meta pixel base code. The hostname gate lives INSIDE the inline script (not around the
// <Script> tag) so the server and client render the same tree — gating the JSX on
// window.location would be a hydration mismatch.
export default function MetaPixel() {
  const pathname = usePathname();
  const first = useRef(true);

  // the base snippet fires the initial PageView; App Router client navigations don't
  // reload the page, so re-fire on every route change after the first
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.fbq?.("track", "PageView");
  }, [pathname]);

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`(function(){
  if (${JSON.stringify(META_PIXEL_HOSTS)}.indexOf(location.hostname) === -1) return;
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '${META_PIXEL_ID}');
  fbq('track', 'PageView');
})();`}
    </Script>
  );
}
