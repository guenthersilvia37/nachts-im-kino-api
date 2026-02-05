import { chromium } from "playwright";

export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

  // Warten bis Spielzeiten sichtbar sind
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const times = [...document.querySelectorAll("*")]
      .map(el => el.textContent?.trim())
      .filter(t => /^\d{2}:\d{2}$/.test(t));

    return [...new Set(times)];
  });

  await browser.close();
  return data;
}