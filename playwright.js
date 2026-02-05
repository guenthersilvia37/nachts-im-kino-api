import { chromium } from "playwright";

export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const times = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);

    const matches = all.filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    return Array.from(new Set(matches));
  });

  // ✅ WICHTIG: Log für Debug in Fly.io
  console.log("[PLAYWRIGHT] URL:", url);
  console.log("[PLAYWRIGHT] times_found:", times.length);
  console.log("[PLAYWRIGHT] sample:", times.slice(0, 20));

  await browser.close();

  // (noch) nur Zeiten zurückgeben – später bauen wir daraus days/movies
  return times;
}