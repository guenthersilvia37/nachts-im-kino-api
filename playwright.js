import { chromium } from "playwright";

export async function getShowtimesFromWebsite(url) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    // ⛔ HARTE TIMEOUT-GRENZEN
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });

    // Nur kurz warten
    await page.waitForTimeout(2000);

    // ⛏️ Extrem simples Scraping (nur Uhrzeiten)
    const times = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("body *"))
        .map(el => el.textContent?.trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t))
        .slice(0, 40);
    });

    if (!times.length) {
      return [];
    }

    // 👉 Minimal gültiges Format für dein Frontend
    const today = new Date();
    return [{
      day: today.toLocaleDateString("de-DE", { weekday: "short" }),
      date: today.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      movies: [{
        title: "Programm",
        times
      }]
    };

  } catch (e) {
    console.log("Playwright scrape failed:", e.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}