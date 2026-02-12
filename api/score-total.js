import * as cheerio from "cheerio";

const CAMPAIGN_URL = "https://fundraisemyway.cancer.ca/campaigns/scoreforcancer";
const GOAL = 250000;

// In-memory last known good value (works per serverless instance)
let lastKnown = null;

function parseMoneyToNumber(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatMoney(n) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0
  }).format(n);
}

function extractFromDom($) {
  // Try likely campaign counters first
  const domCandidates = [
    $('[data-testid*="raised"]').first().text(),
    $('[class*="raised"]').first().text(),
    $('[class*="donation"]').first().text(),
    $('[class*="amount"]').first().text(),
  ].filter(Boolean);

  for (const c of domCandidates) {
    const n = parseMoneyToNumber(c);
    if (n && n > 0) return { value: n, method: "dom-candidate" };
  }

  // Fallback: find all currency-like tokens and choose a plausible max
  const bodyText = $("body").text() || "";
  const matches = bodyText.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  const nums = matches
    .map(parseMoneyToNumber)
    .filter((x) => Number.isFinite(x) && x > 0);

  if (nums.length) {
    const max = Math.max(...nums);
    return { value: max, method: "body-currency-max" };
  }

  return null;
}

export default async function handler(req, res) {
  try {
    const resp = await fetch(CAMPAIGN_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-CA,en;q=0.9"
      },
      cache: "no-store"
    });

    if (!resp.ok) {
      if (lastKnown) {
        return res.status(200).json({
          ...lastKnown,
          stale: true,
          note: "source fetch failed; returning last known value"
        });
      }
      return res.status(502).json({ error: "Failed to fetch campaign page" });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const extracted = extractFromDom($);

    if (!extracted?.value) {
      if (lastKnown) {
        return res.status(200).json({
          ...lastKnown,
          stale: true,
          note: "parse failed; returning last known value"
        });
      }
      return res.status(500).json({ error: "Could not parse total raised" });
    }

    const totalRaised = extracted.value;
    const progressPct = GOAL ? Number(((totalRaised / GOAL) * 100).toFixed(2)) : null;

    const payload = {
      totalRaised,
      totalRaisedDisplay: formatMoney(totalRaised),
      goal: GOAL,
      goalDisplay: GOAL ? formatMoney(GOAL) : null,
      progressPct,
      updatedAt: new Date().toISOString(),
      source: CAMPAIGN_URL,
      method: extracted.method,
      stale: false
    };

    lastKnown = payload;

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (e) {
    if (lastKnown) {
      return res.status(200).json({
        ...lastKnown,
        stale: true,
        note: "exception; returning last known value"
      });
    }
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
