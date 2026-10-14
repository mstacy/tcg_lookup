# TCG Lookup

Point a laptop or phone camera at a trading card to identify the game and read the card's title.

## How it works

1. **In-browser detection (OpenCV.js):** finds the card's outline in the live feed, waits until it's held steady, then perspective-corrects the card into a flat 630×880 crop.
2. **Identification (`/api/identify`):** sends the crop to Claude (`claude-opus-5-5`, structured output), which returns `isCard`, `game`, and `title`.
3. **Verification:** Magic: The Gathering cards are matched against Scryfall, using the set code and collector number when they're legible so the exact printing is found. To add another game, register a verifier in `lib/verify/index.ts`.
4. **Pricing ([JustTCG](https://justtcg.com)):** set, rarity, number, and TCGplayer market prices for every condition and finish (Normal/Foil). It covers Magic, Cyberpunk TCG, Pokémon, and more. Magic printings are priced exactly via their Scryfall id; other games are searched by name and ranked by collector number. When the set can't be read, a set dropdown lets you pick the printing. Without a `JUSTTCG_API_KEY` (or when JustTCG is unavailable), Magic falls back to Scryfall's Near Mint price.

## 24-hour caching

- **On the device:** each scan is fingerprinted with ORB keypoints (`lib/cardMatcher.ts`) and kept in localStorage for 24 h. Rescanning the same card is answered instantly with no server call. "Rescan (skip cache)" forces a fresh read and replaces the cached entry.
- **On the server:** card-database lookups and prices are cached per card for 24 h (`lib/verify/index.ts`, `lib/pricing/index.ts`). JustTCG's free plan allows 100 requests a day and 1,000 a month, so this keeps repeat scans free. The cache lives in memory; swap in Redis/KV through the `TtlCache` interface in `lib/cache.ts` if you deploy to serverless.

## Setup

```bash
cp .env.local.example .env.local   # add your ANTHROPIC_API_KEY
npm install
npm run dev                        # http://localhost:3000
```

**On a phone:** cameras only work over HTTPS. Run `npm run dev:https` and open `https://<your-lan-ip>:3000` on the phone, accepting the self-signed certificate. Or deploy to Vercel.

## Config (`.env.local`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | required |
| `JUSTTCG_API_KEY` | none | prices by condition; free key at justtcg.com |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | |
| `CACHE_TTL_MS` | `86400000` | server lookup cache TTL |
| `RATE_LIMIT_PER_MINUTE` | `20` | per-IP limit on model calls |
| `NEXT_PUBLIC_OPENCV_URL` | jsDelivr `@techstark/opencv-js@4.10.0-release.1` | self-host to avoid the CDN |
# tcg_lookup
