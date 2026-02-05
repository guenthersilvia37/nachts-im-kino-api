import { chromium } from "playwright";

// Erwartetes Format für server.js: days = [{day,date,movies:[{title,times,poster,info}]}]
export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    locale: "de-DE",
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // weniger “auffallen”: keine Bilder/Fonts laden
  await page.route("**/*", (route) => {
    const rt = route.request().resourceType();
    if (rt === "image" || rt === "font") return route.abort();
    return route.continue();
  });

  let finalUrl = url;
  let status = null;

  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    status = resp?.status?.() ?? null;

    // warten auf nachgeladene Inhalte
    await page.waitForTimeout(4000);
    // noch ein bisschen scrollen (falls lazy load)
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(2000);

    finalUrl = page.url();

    // Frames (sehr wichtig: viele Kinos haben Spielzeiten als iframe)
    const frames = page.frames().map((f) => f.url()).filter(Boolean);

    // Text aus Seite + allen Frames sammeln
    const allTexts = [];

    // Hauptseite
    const mainText = await page.evaluate(() => document.body?.innerText || "");
    allTexts.push(mainText);

    // Frames
    for (const f of page.frames()) {
      try {
        const t = await f.evaluate(() => document.body?.innerText || "");
        if (t) allTexts.push(t);
      } catch {}
    }

    const bigText = allTexts.join("\n");

    // Zeiten finden
    const times = Array.from(bigText.matchAll(/\b([01]\d|2[0-3]):[0-5]\d\b/g)).map((m) => m[0]);
    const uniqTimes = [...new Set(times)];

    // Wenn wir nur Zeiten finden, aber keine Filmtitel: wir geben “unknown” Film zurück
    // (damit du zumindest siehst, dass Scraping grundsätzlich klappt)
    const days = [];
    const now = new Date();

    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);

      days.push({
        day: d.toLocaleDateString("de-DE", { weekday: "short" }),
        date: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
        movies: uniqTimes.length
          ? [
              {
                title: "Spielzeiten (Quelle: Website)",
                times: uniqTimes.slice(0, 30),
                poster: null,
                info: { description: null, runtime: null, genres: [], cast: [] },
              },
            ]
          : [],
      });
    }

    await browser.close();

    return {
      days,
      debug: {
        status,
        finalUrl,
        frameCount: frames.length,
        frames: frames.slice(0, 10),
        foundTimes: uniqTimes.length,
        textSnippet: bigText.slice(0, 1200),
      },
    };
  } catch (e) {
    await browser.close();
    return {
      days: [],
      debug: {
        status,
        finalUrl,
        error: String(e?.message || e),
      },
    };
  }
}