import { chromium } from "playwright";

// Kleine Helfer
function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function normTitle(s) {
  return String(s || "")
    .replace(/\s{2,}/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function extractDayAndDate(label) {
  const txt = String(label || "").trim();

  // versucht sowas wie: "Mi · 04.02." oder "Mi 04.02." oder nur "04.02."
  const dateMatch = txt.match(/(\d{1,2}\.\d{1,2}\.)/);
  const dayMatch = txt.match(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/i);

  return {
    day: dayMatch ? dayMatch[1] : "",
    date: dateMatch ? dateMatch[1] : "",
  };
}

// Hauptfunktion: gibt days[] zurück
export async function getShowtimesFromWebsite(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Viele Kinoseiten laden nach -> kurz warten
    await page.waitForTimeout(1500);

    // 1) Finde “Day Tabs/Buttons” (irgendwas mit 04.02. oder Wochentag)
    //    Wenn keine gefunden werden, scrapen wir nur den aktuell sichtbaren Stand als “heute”.
    const dayCandidates = page
      .locator("button, a, [role='tab'], [data-date]")
      .filter({ hasText: /\b(Mo|Di|Mi|Do|Fr|Sa|So)\b|\d{1,2}\.\d{1,2}\./i });

    let count = await dayCandidates.count();
    if (count > 25) count = 25; // Safety

    // Sammle eindeutige Day-Labels (damit wir nicht 100 Buttons doppelt klicken)
    const labels = [];
    for (let i = 0; i < count; i++) {
      const t = normTitle(await dayCandidates.nth(i).innerText().catch(() => ""));
      if (!t) continue;
      if (!/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b|\d{1,2}\.\d{1,2}\./i.test(t)) continue;
      if (!labels.includes(t)) labels.push(t);
      if (labels.length >= 7) break;
    }

    // Scrape-Funktion (aktueller Zustand der Seite)
    const scrapeCurrentView = async () => {
      return await page.evaluate(() => {
        const isTime = (s) => /^\d{1,2}:\d{2}$/.test(String(s || "").trim());

        // Suche Times als einzelne Textnodes/Elemente
        const timeEls = Array.from(document.querySelectorAll("body *"))
          .map((el) => ({ el, txt: (el.textContent || "").trim() }))
          .filter((x) => isTime(x.txt));

        // Hilfsfunktion: im Umfeld einen plausiblen Filmtitel finden
        const findTitleNear = (startEl) => {
          let el = startEl;
          for (let up = 0; up < 6 && el; up++) {
            // 1) klassische title-Selector
            const cand =
              el.querySelector?.("h1,h2,h3,h4,.title,.movie-title,.film-title,strong") ||
              null;

            const t1 = (cand?.textContent || "").trim();
            if (t1 && t1.length >= 2 && t1.length <= 120) return t1;

            // 2) sonst: vorherige Überschriften im Container suchen
            const heads = el.querySelectorAll?.("h1,h2,h3,h4") || [];
            for (const h of heads) {
              const t2 = (h.textContent || "").trim();
              if (t2 && t2.length >= 2 && t2.length <= 120) return t2;
            }

            el = el.parentElement;
          }
          return "Film";
        };

        const map = new Map(); // title -> Set(times)
        for (const x of timeEls) {
          const title = findTitleNear(x.el);
          const key = String(title || "Film").trim();
          if (!map.has(key)) map.set(key, new Set());
          map.get(key).add(String(x.txt).trim());
        }

        const movies = Array.from(map.entries()).map(([title, timesSet]) => ({
          title,
          times: Array.from(timesSet).sort(),
          poster: null,
          info: { description: null, runtime: null, genres: [], cast: [] },
        }));

        // Falls gar nichts gefunden, leeres Array
        return movies;
      });
    };

    const daysOut = [];

    // 2) Wenn wir Day-Buttons haben: klicke sie nacheinander und scrape
    if (labels.length) {
      for (const label of labels) {
        // versuch passenden Button wiederzufinden und zu klicken
        const btn = page
          .locator("button, a, [role='tab'], [data-date]")
          .filter({ hasText: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
          .first();

        // klicken (wenn möglich)
        await btn.click({ timeout: 4000 }).catch(() => null);

        // warten bis die Seite neu rendert
        await page.waitForTimeout(800);

        const movies = await scrapeCurrentView();

        const { day, date } = extractDayAndDate(label);
        daysOut.push({
          day: day || "",
          date: date || "",
          movies,
        });

        if (daysOut.length >= 7) break;
      }
    } else {
      // 3) Keine Tabs gefunden -> “heute” scrapen
      const movies = await scrapeCurrentView();
      const now = new Date();
      daysOut.push({
        day: now.toLocaleDateString("de-DE", { weekday: "short" }),
        date: now.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
        movies,
      });
    }

    // Aufräumen: doppelte Tage raus (falls Labels komisch)
    const seen = new Set();
    const cleaned = [];
    for (const d of daysOut) {
      const key = `${d.day}__${d.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Movies: leere Titel entfernen, Zeiten unique machen
      const movies = (d.movies || [])
        .map((m) => ({
          ...m,
          title: normTitle(m.title) || "Film",
          times: uniq(m.times).sort(),
        }))
        .filter((m) => m.times.length > 0);

      cleaned.push({ ...d, movies });
    }

    return cleaned;
  } finally {
    await browser.close().catch(() => null);
  }
}