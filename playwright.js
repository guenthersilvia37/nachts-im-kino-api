// playwright.js
import { chromium } from "playwright";

function buildSevenDaysSkeleton() {
  const now = new Date();
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    out.push({
      day: d.toLocaleDateString("de-DE", { weekday: "short" }),
      date: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      movies: [],
    });
  }
  return out;
}

export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);

    // 1) Uhrzeiten einsammeln (robust)
    const times = await page.evaluate(() => {
      const re = /\b([01]\d|2[0-3]):[0-5]\d\b/g;
      const set = new Set();

      // Nimm viel Text, aber nicht ALLES (Performance)
      const texts = [];
      const candidates = document.querySelectorAll(
        "main, #main, .main, .content, .container, body"
      );

      const root = candidates.length ? candidates[0] : document.body;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

      let node;
      let count = 0;
      while ((node = walker.nextNode()) && count < 8000) {
        const t = (node.textContent || "").trim();
        if (t) texts.push(t);
        count++;
      }

      const big = texts.join(" ");
      const matches = big.match(re) || [];
      matches.forEach((m) => set.add(m));
      return Array.from(set);
    });

    // Keine Zeiten gefunden → leeres days (Server macht ok:false)
    if (!times.length) return [];

    // 2) In days-Format packen
    // Minimaler Ansatz: wir zeigen die gefundenen Zeiten unter "Programm" für HEUTE.
    // (Besser: später pro Kinoseite/Provider echte Tagesgruppen parsen.)
    const days = buildSevenDaysSkeleton();
    days[0].movies = [
      {
        title: "Programm",
        times,
        poster: null,
        info: { description: null, runtime: null, genres: [], cast: [] },
      },
    ];

    return days;
  } finally {
    await browser.close();
  }
}