import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// CORS
// --------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------
// Health
// --------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// --------------------
// Helpers
// --------------------
function escStr(v) {
  return String(v ?? "");
}

function pickCity(geoItem, fallback) {
  const a = geoItem?.address || {};
  return (
    a.city ||
    a.town ||
    a.village ||
    a.municipality ||
    a.county ||
    geoItem?.display_name?.split(",")?.[0] ||
    fallback
  );
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Blocklist (Erwachsenen/Noise) – sowohl Backend als auch Frontend kann zusätzlich filtern
const BLOCKED_WORDS = [
  "erotik",
  "sex",
  "sextoy",
  "adult",
  "bordell",
  "strip",
  "sauna club",
  "massage",
  "escort",
  "erdbeermund",
];

function isBlockedTitle(title) {
  const t = escStr(title).toLowerCase();
  return BLOCKED_WORDS.some((w) => t.includes(w));
}

// Kino erkennen
function isCinemaPlace(p) {
  const title = escStr(p?.title || p?.name).toLowerCase();
  const type = escStr(p?.type).toLowerCase();
  const category = escStr(p?.category).toLowerCase();

  if (isBlockedTitle(title)) return false;

  const cinemaWords = [
    "kino",
    "cinema",
    "cine",
    "film",
    "lichtspiel",
    "filmpalast",
    "metropolis",
    "kinopolis",
    "cineplex",
    "cinestar",
    "cinemaxx",
    "uci",
  ];

  const looksLikeCinemaByText = cinemaWords.some((w) => title.includes(w));

  const looksLikeCinemaByCategory =
    category.includes("movie") ||
    category.includes("cinema") ||
    type.includes("movie") ||
    type.includes("cinema");

  return looksLikeCinemaByText || looksLikeCinemaByCategory;
}

function normalizeCinema(p) {
  return {
    title: p?.title || p?.name || "Kino",
    address: p?.address || p?.full_address || "",
    rating: p?.rating ?? null,
    reviews: p?.reviews ?? null,
    place_id: p?.place_id || p?.data_id || null,
    link: p?.link || p?.website || null,
    gps_coordinates: p?.gps_coordinates || null,
  };
}

// Showtimes normalisieren (aus SerpApi `showtimes`)
function normalizeShowtimes(showtimesArr) {
  // SerpApi liefert z.B.
  // - für theaters: showtimes[].movies[].showing[].time[]
  // - für movies: showtimes[].theaters[].showing[].time[]
  // Wir fokussieren hier auf "theaters"-Variante (Kino -> Filme)
  const days = [];

  for (const d of (showtimesArr || [])) {
    const dayLabel = d?.day || "";
    const dateLabel = d?.date || "";
    const movies = [];

    for (const m of (d?.movies || [])) {
      const title = m?.name || m?.title || "";
      const times = [];

      for (const s of (m?.showing || [])) {
        for (const t of (s?.time || [])) times.push(t);
      }

      // Duplikate raus, Reihenfolge behalten
      const uniqTimes = [...new Set(times)].filter(Boolean);

      movies.push({
        title,
        link: m?.link || null,
        times: uniqTimes,
      });
    }

    days.push({
      day: dayLabel,
      date: dateLabel,
      movies,
    });
  }

  return days;
}

// --------------------
// Nominatim
// --------------------
async function nominatimSearch(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=" +
    encodeURIComponent(q);

  const r = await fetch(url, {
    headers: { "User-Agent": "nachts-im-kino/1.0 (render)" },
  });

  if (!r.ok) return [];
  return r.json();
}

// --------------------
// SerpApi: Google Maps (Kinos)
// --------------------
async function serpApiGoogleMaps({ key, city, lat, lon }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("q", `Kino in ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", key);

  if (lat && lon) url.searchParams.set("ll", `@${lat},${lon},12z`);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
}

// --------------------
// SerpApi: Google Search (Showtimes-Block)
// Wichtig: KEIN tbm=mv erzwingen!
// Wir triggern den Showtimes-Block über Query + Location.
// SerpApi packt ihn dann als `showtimes` ins JSON.  [oai_citation:2‡SerpApi](https://serpapi.com/showtimes-results)
// --------------------
async function serpApiShowtimes({ key, cinemaName, city }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `${cinemaName} Spielzeiten ${city}`);
  url.searchParams.set("location", `${city}, Germany`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("api_key", key);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
}

// --------------------
// GET /api/cinemas?q=...
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt (z. B. ?q=10115 oder ?q=Köln)" });

    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    const result = await serpApiGoogleMaps({ key, city, lat, lon });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler", details: result.data });
    }

    const raw = result.data?.local_results || result.data?.place_results || [];
    const cinemas = raw
      .filter(isCinemaPlace)
      .map(normalizeCinema)
      .filter((c) => !isBlockedTitle(c.title));

    return res.json({
      ok: true,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// GET /api/showtimes?name=...&city=...
// -> liefert days[] (Kalender) mit movies + times
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();

    if (!name) return res.status(400).json({ ok: false, error: "name fehlt (z. B. ?name=Filmpalast%20K%C3%B6ln)" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt (z. B. ?city=K%C3%B6ln)" });

    if (isBlockedTitle(name)) {
      return res.status(400).json({ ok: false, error: "Dieses Kino ist blockiert." });
    }

    const result = await serpApiShowtimes({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler (showtimes)", details: result.data });
    }

    const showtimesArr = result.data?.showtimes || [];
    const days = normalizeShowtimes(showtimesArr);

    return res.json({
      ok: true,
      cinema: name,
      city,
      days,           // ✅ für Kalender im Frontend
      raw_has_showtimes: Array.isArray(showtimesArr) && showtimesArr.length > 0,
      // raw: result.data, // nur zum Debuggen (optional)
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});