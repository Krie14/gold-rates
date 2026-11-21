# Precious Rates

A static website that shows live gold and silver prices, rates by purity, price history and a diamond price estimator, in 160+ currencies and any common weight (gram, 10 g, tola, troy ounce, kilogram).

No server, database or build step. It's plain HTML, CSS and JavaScript plus a small daily job.

## How the data stays current

| What | Where it comes from | How often |
|---|---|---|
| Gold and silver spot | gold-api.com, with xaus.com as backup | Every 60 seconds while a visitor has the page open |
| Daily snapshot and history | `scripts/update-prices.mjs` saves to `data/` | Once a day through GitHub Actions (00:17 UTC) |
| Exchange rates | open.er-api.com | Once a day (in the snapshot) |
| Diamond estimates | `data/diamonds.json` reference table | Whenever you edit it or connect a feed (see below) |

If the live sources are down, the page falls back to the last daily snapshot and says so. The first time the job runs it also loads about five years of gold history, so the chart is full from day one. Silver history builds up one day at a time.

## Put it online (GitHub Pages, about 5 minutes)

1. Create a new repository on GitHub and upload every file in this folder, including the hidden `.github` folder.
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
3. Open **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**, so the daily job can save prices.
4. Open the **Actions** tab, pick **Update prices** and click **Run workflow** once. This fills `data/` straight away instead of waiting for midnight.
5. Your site is live at `https://<your-username>.github.io/<repo-name>/`. To use your own domain, add it under **Settings → Pages → Custom domain**.

### Netlify, Vercel or Cloudflare Pages instead

Do steps 1, 3 and 4 above, then import the GitHub repository into Netlify, Vercel or Cloudflare Pages. You don't need a build command, and the publish directory is the repository root. Each daily commit from the job redeploys the site automatically.

## Preview on your computer

Browsers block data files opened straight from disk, so run a tiny local server from this folder:

```
python3 -m http.server 8000
```

Then open http://localhost:8000. To refresh the saved data by hand, run `node scripts/update-prices.mjs` (Node 18 or newer).

## Diamond prices

There's no free, public live feed for diamond prices. The trade benchmarks (Rapaport, IDEX and similar) are paid and licensed. This site estimates from a reference table in `data/diamonds.json`:

- `natural_per_carat` and `lab_per_carat` hold the USD price per carat for a G colour, VS2, Excellent-cut round stone, by size band.
- `color`, `clarity` and `cut` are multipliers on that base.
- `spread` sets the ± range shown to visitors.

Update the numbers whenever you like, and the site uses them immediately. If you subscribe to a feed, add `DIAMOND_FEED_URL` (and `DIAMOND_FEED_TOKEN` if it needs one) under **Settings → Secrets and variables → Actions**. The daily job will then replace the table with the feed, which has to return JSON in the same shape as `diamonds.json`.

## Customising

- **Name and text:** `index.html`.
- **Colours and fonts:** the variables at the top of `styles.css`.
- **Currencies shown first and the default currency per country:** `PREFERRED_CURRENCIES` and `REGION_CURRENCY` in `app.js`.
- **Purities:** `PURITIES` in `app.js`.
- **Update time:** the `cron` line in `.github/workflows/update-prices.yml` (UTC).

## Usage terms of the free sources

- The open.er-api.com terms require the visible "Rates By Exchange Rate API" link in the footer. Keep it.
- xaus.com asks you to contact them if you go above about 10,000 requests a day. gold-api.com is free with no key.
- All prices are indicative mid-market rates, not dealer quotes. The footer says so.
