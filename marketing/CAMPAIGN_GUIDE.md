# Onside — Meta campaign launch guide

Creatives: `creatives/out/` (9 PNGs). Copy: `AD_COPY.md`. Re-render after edits:
`node marketing/creatives/render.mjs`.

## Phase 0 — before spending (one-time setup)

1. **Business Manager**: business.facebook.com → create business "Thinka Platforms LTD".
   Add your Facebook Page for Onside (create one if none — ads run from a Page).
2. **Verify the domain**: Business settings → Brand safety → Domains → add `onside.com.ng`
   → verify via DNS TXT record (I can add this to the DNS if you tell me the registrar).
3. **Ad account**: create in Business settings, currency **NGN**, add a payment card.
4. **Meta Pixel + Conversions API** — *not yet wired into the app.* Ask me and I'll build it:
   pixel base code + `CompleteRegistration` on signup + a custom `FirstSlipUpload` event
   (the real activation signal). **Don't fund the campaign before this exists** — without it
   Meta optimizes for clickers, not users.
5. **Page + IG**: link the Instagram account to the Page (Meta Business Suite → Settings).

## Phase 1 — campaign structure (Ads Manager)

Create ONE campaign:

- **Objective**: Leads → website (or "Sales" objective with CompleteRegistration once pixel
  is live). Do NOT pick Awareness/Traffic — cheap clicks, zero users.
- **Special ad category**: leave OFF (we are not a gambling operator; the app is a tracker).
  If Meta review reclassifies, see the rejection playbook in `AD_COPY.md`.
- **Budget**: Advantage campaign budget, **₦7,000/day** to start. Schedule ads to run all day
  (bettors browse in the evening + matchday, let delivery find it).
- **One ad set**:
  - Location: Nigeria. Age: **18–55**. Gender: all.
  - Advantage+ audience ON, with interest suggestions: football, English Premier League,
    La Liga, Champions League. No lookalikes yet (no seed audience).
  - Placements: Advantage+ (all). The three sizes cover feed (1:1), Stories/Reels (9:16),
    and right column/link (1.91:1) automatically.
- **Three ads** in the ad set (one per concept — Meta rotates and finds the winner):
  - Ad 1 "Snap": `concept-a-snap-*` images + Concept A copy
  - Ad 2 "Record": `concept-b-record-*` + Concept B copy
  - Ad 3 "Chaos": `concept-c-chaos-*` + Concept C copy
  - For each ad, upload all 3 sizes and assign per placement (Meta prompts for this).
  - URL parameters on every ad: `utm_source=meta&utm_medium=paid&utm_campaign=launch&utm_content={{ad.name}}`

## Phase 2 — the two-week test

- **Week 1: do not touch anything.** Learning phase resets on every edit.
- **Judge on**: cost per registration, and cost per first-slip-upload (the number that
  matters). Clicks/CPM are vanity here.
- **Week 2**: kill any ad with 2× the cost-per-registration of the best one; move budget to
  the winner. If one concept dominates, ask me for 2–3 variants of that concept (new
  headline/visual twist, same angle).
- **Healthy early signals** (Nigeria, this vertical): CPM ₦800–2,500, CTR >1%,
  cost per registration under ₦300–500. If registration cost is fine but slip-uploads lag,
  the problem is onboarding, not ads — tell me and I'll look at the first-run flow.

## Phase 3 — after the test

- Winner found → raise budget ~20% every 3–4 days (bigger jumps reset learning).
- Build a **lookalike audience** from FirstSlipUpload users once there are ~500 of them.
- Retarget site visitors who didn't register (needs pixel; 7-day window, light budget).
- Refresh creative every 3–4 weeks — frequency >3 means people see it too often.

## Ongoing rules

- Never A/B by editing a live ad — duplicate, change, launch the copy.
- Check Account Quality weekly for policy flags; appeal rejections once, then swap creative.
- Keep every ad 18+, no odds/winnings/bookmaker references (full rules in `AD_COPY.md`).
- Comment moderation: hide/report scam "contact my manager" replies daily — they kill trust
  under betting-adjacent ads in Nigeria.
