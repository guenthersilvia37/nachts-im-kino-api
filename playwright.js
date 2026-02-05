import { chromium } from "playwright";

export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  // etwas “menschlicher” wirken
  await page.setViewportSize({ width: 1280, height: 800 });

  let debug = {
    url,
    finalUrl: null,
    title: null,
    status: null,
    hasCookieHints: false,
    foundTimes: [],
    textSample: ""
  };

  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    debug.status = resp?.status() ?? null;

    // kurz warten, damit JS nachladen kann
    await page.waitForTimeout(5000);

    debug.finalUrl = page.url();
    debug.title = await page.title();

    // Groben Cookie/Banner Hinweis erkennen (nur fürs Debug)
    const html = await page.content();
    debug.hasCookieHints = /cookie|consent|datenschutz|privacy|zustimmen|akzeptieren/i.test(html);

    // Sichtbaren Text sample (damit wir wissen, ob Inhalt überhaupt da ist)
    const text = await page.evaluate(() => document.body?.innerText || "");
    debug.textSample = String(text).replace(/\s+/g, " ").trim().slice(0, 800);

    // Uhrzeiten suchen (sichtbarer Text)
    const times = (text.match(/\b([01]\d|2[0-3]):[0-5]\d\b/g) || []);
    debug.foundTimes = [...new Set(times)].slice(0, 80);
  } catch (e) {
    debug.error = String(e?.message || e);
  } finally {
    await browser.close();
  }

  // WICHTIG: Wir geben erstmal absichtlich "keine Days" zurück,
  // sondern nur Debug – damit wir als nächstes gezielt fixen können.
  return { days: [], debug };
}