// playwright.js
import { chromium } from "playwright";

function build7DaysWithTimes(times) {
  const now = new Date();
  const mk = (offset) => {
    const d = new Date(now);
    d.setDate(now.getDate() + offset);
    return {
      day: d.toLocaleDateString("de-DE", { weekday: "short" }),
      date: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      movies: times.length
        ? [{
            title: "Spielzeiten",
            times,
            poster: null,
            info: { description: null, runtime: null, genres: [], cast: [] },
          }]
        : []
    };
  };
  return Array.from({ length: 7 }, (_, i) => mk(i));
}

function extractTimesFromText(text) {
  const s = String(text || "");

  // akzeptiert: 19:30, 19.30, 9:05, 09:05, optional "Uhr"
  const re = /\b([01]?\d|2[0-3])[:.][0-5]\d\b/g;

  const found = s.match(re) || [];
  // normalisieren auf HH:MM
  const norm = found.map(t => {
    const x = t.replace(".", ":");
    const [h, m] = x.split(":");
    const hh = String(h).padStart(2, "0");
    return `${hh}:${m}`;
  });

  // uniq + sort
  return [...new Set(norm)].sort();
}

export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "de-DE",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // kurz warten, damit JS Inhalte nachlädt
    await page.waitForTimeout(2500);

    // 1) Zeiten aus sichtbarem Text sammeln
    const visibleText = await page.evaluate(() => document.body?.innerText || "");
    let times = extractTimesFromText(visibleText);

    // 2) Wenn nix: Zeiten aus HTML-Quelle sammeln (manche Seiten rendern in JSON/Script)
    if (!times.length) {
      const html = await page.content();
      times = extractTimesFromText(html);
    }

    await browser.close();

    // wichtig: server.js erwartet days[]
    return build7DaysWithTimes(times);
  } catch (e) {
    await browser.close();
    // gib leere days zurück (server.js füllt zur Not eh auf)
    return build7DaysWithTimes([]);
  }
}