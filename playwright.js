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
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    await Promise.race([
  page.goto(url, { waitUntil: "domcontentloaded" }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout beim Laden der Seite")), 15000)
  )
]);

    await page.waitForTimeout(2500);

    const times = await page.evaluate(() => {
      const rx = /^\d{1,2}:\d{2}$/;
      const out = [];

      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const t = el.textContent?.trim();
        if (t && rx.test(t)) out.push(t);
        if (out.length >= 80) break;
      }

      return Array.from(new Set(out));
    });

    const debug = {
      url,
      times_found: times.length,
      sample: times.slice(0, 10),
    };

    if (!times.length) {
      return { days: [], debug };
    }

    const today = new Date();

    return {
      days: [
        {
          day: today.toLocaleDateString("de-DE", { weekday: "short" }),
          date: today.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
          movies: [
            {
              title: "Programm",
              times,
              poster: null,
              info: { description: null, runtime: null, genres: [], cast: [] },
            },
          ],
        },
      ],
      debug,
    };
  } catch (e) {
    return {
      days: [],
      debug: { url, error: String(e?.message || e) },
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}