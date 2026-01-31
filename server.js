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

// --------------------
// Blocklist (Erotik/Noise)
// --------------------
const BLOCKED_WORDS = [
  "erotik",
  "sex",
  "sextoy",
  "adult",
  "bordell",
  "strip",
  "sauna",
  "sauna club",
  "massage",
  "escort",
  "erdbeermund",
];

function isBlockedTitle(title) {
  const t = escStr(title).toLowerCase();
  return BLOCKED_WORDS.some((w) => t.includes(w));
}

// --------------------
// Kino erkennen
// --------------------
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

  // SerpApi google_maps liefert manchmal type/category
  const looksLikeCinemaByCategory =
    category.includes("movie") ||
    category.includes("cinema") ||
    type.includes("movie") ||
    type.includes("cinema");

  return looksLikeCinemaByText || looksLikeCinemaByCategory;
}

function normalizeCinema(p) {
  const title = p?.title || p?.name || "Kino";
  return {
    title,
    address: p?.address || p?.full_address || "",
    rating: p?.rating ?? null,
    reviews: p?.reviews ?? null,
    place_id: p?.place_id || p?.data_id || null,
    link: p?.link || p?.website || null,
    gps_coordinates: p?.gps_coordinates || null,
  };
}

// --------------------
// Showtimes normalisieren (Kalender)
// Liefert: days[] -> movies[] -> {title, poster, info, times, link}
// --------------------
function normalizeShowtimes(showtimesArr) {
  const days = [];

  for (const d of (showtimesArr || [])) {
    const dayLabel = d?.day || "";
    const dateLabel = d?.date || "";
    const movies = [];

    for (const m of (d?.movies || [])) {
      const title = m?.name || m?.title || "";

      // SerpApi-Felder können variieren -> wir picken das häufigste
      const poster =
        m?.thumbnail ||
        m?.poster ||
        m?.image ||
        (Array.isArray(m?.images) ? m.images[0] : null) ||
        null;

      const info = {
        genre: m?.genre || m?.genres || null,
        duration: m?.duration || m?.runtime || null,
        rating: m?.rating || m?.imdb_rating || null,
        description: m?.description || m?.snippet || null,
      };

      const times = [];
      for (const s of (m?.showing || [])) {
        for (const t of (s?.time || [])) times.push(t);
      }

      const uniqTimes = [...new Set(times)].filter(Boolean);

      movies.push({
        title,
        link: m?.link || null,
        poster,
        info,
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
// Simple Cache (in-memory)
// --------------------
const CACHE = new Map();
// key -> { expires:number, value:any }
function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs) {
  CACHE.set(key, { value, expires: Date.now() + ttlMs });
}

// TTLs
const TTL_CINEMAS = 10 * 60 * 1000;   // 10 min
const TTL_SHOWTIMES = 10 * 60 * 1000; // 10 min

// --------------------
// Nominatim
// --------------------
async function nominatimSearch(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=" +
    encodeURIComponent(q);

  const r = await fetch(url, {
    headers: {
      // Bitte eine halbwegs eindeutige UA nutzen
      "User-Agent": "nachts-im-kino/1.0 (render)",
    },
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

  // Mit Koordinaten kommt "in der Nähe" zuverlässiger
  if (lat && lon) url.searchParams.set("ll", `@${lat},${lon},12z`);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
}

// --------------------
// SerpApi: Google Search (Showtimes Block)
// Wichtig: KEIN tbm=mv setzen!
// Wir triggern Showtimes über Query + Location.
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

    const cacheKey = `cinemas:${q.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

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

    const payload = {
      ok: true,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
    };

    cacheSet(cacheKey, payload, TTL_CINEMAS);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// GET /api/showtimes?name=...&city=...
// -> liefert days[] (Kalender) mit movies + times + poster + info
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

    const cacheKey = `showtimes:${city.toLowerCase()}:${name.toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const result = await serpApiShowtimes({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        error: "SerpApi Fehler (showtimes)",
        details: result.data,
      });
    }

    const showtimesArr = result.data?.showtimes || [];
    const days = normalizeShowtimes(showtimesArr);

    // Wenn SerpApi keinen Showtimes-Block liefert:
    // -> wir geben ok:true zurück, aber days leer + Hinweis fürs Frontend
    const payload = {
      ok: true,
      cinema: name,
      city,
      days,
      raw_has_showtimes: Array.isArray(showtimesArr) && showtimesArr.length > 0,
      hint: (!showtimesArr?.length)
        ? "Google/SerpApi hat keinen Showtimes-Block geliefert. Das ist leider normal und schwankt je nach Kino/Stadt."
        : null,
    };

    cacheSet(cacheKey, payload, TTL_SHOWTIMES);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});