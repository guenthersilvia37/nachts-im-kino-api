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

// Blocklist (Erotik/Noise)
const BLOCKED_WORDS = [
  "erotik",
  "sex",
  "sextoy",
  "adult",
  "bordell",
  "strip",
  "sauna club",
  "sauna",
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
// SerpApi: Showtimes Block (Google Search)
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
// Poster Cache (TTL)
// --------------------
const posterCache = new Map(); // key -> { t, v }
const POSTER_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function getCache(key) {
  const entry = posterCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > POSTER_CACHE_TTL_MS) {
    posterCache.delete(key);
    return null;
  }
  return entry.v;
}

function setCache(key, value) {
  posterCache.set(key, { t: Date.now(), v: value });
}

// --------------------
// SerpApi: Poster-Fallback via google_images (besser als KG-only)
// --------------------
async function serpApiPoster({ key, title, hl = "de", gl = "de" }) {
  const cacheKey = `img::${hl}::${gl}::${title}`.toLowerCase();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", `${title} film poster`);
  url.searchParams.set("hl", hl);
  url.searchParams.set("gl", gl);
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("safe", "active");
  url.searchParams.set("api_key", key);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok || !data) {
    const fallback = { ok: false, poster: null };
    setCache(cacheKey, fallback);
    return fallback;
  }

  const first = Array.isArray(data.images_results) ? data.images_results[0] : null;
  const poster = first?.thumbnail || first?.original || null;

  const result = { ok: true, poster };
  setCache(cacheKey, result);
  return result;
}

// --------------------
// SerpApi: Movie-Info (Snippet + Link) via normal Google
// (optional, aber hilfreich für “Mehr Infos”)
// --------------------
async function serpApiMovieInfo({ key, movieTitle }) {
  const cacheKey = `info::${movieTitle}`.toLowerCase();
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `${movieTitle} Film`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("api_key", key);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  const first = Array.isArray(data?.organic_results) ? data.organic_results[0] : null;
  const snippet = first?.snippet || data?.knowledge_graph?.description || null;
  const link = data?.knowledge_graph?.website || data?.knowledge_graph?.link || first?.link || null;

  const result = { snippet, link };
  setCache(cacheKey, result);
  return result;
}

// --------------------
// Showtimes normalisieren (Kino -> Filme -> Zeiten)
// --------------------
function normalizeShowtimes(showtimesArr) {
  const days = [];

  for (const d of showtimesArr || []) {
    const dayLabel = d?.day || "";
    const dateLabel = d?.date || "";

    const movies = [];
    for (const m of d?.movies || []) {
      const title = m?.name || m?.title || "";

      const times = [];
      for (const s of m?.showing || []) {
        for (const t of s?.time || []) times.push(t);
      }
      const uniqTimes = [...new Set(times)].filter(Boolean);

      movies.push({
        title,
        link: m?.link || null, // manchmal Kino-Info-Link
        times: uniqTimes,
        poster: m?.thumbnail || m?.poster || null, // falls SerpApi doch eins liefert
        info: {
          description: null,
        },
        infoLink: null,
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
// -> liefert days[] mit movies(times, poster?, info?)
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();

    if (!name) return res.status(400).json({ ok: false, error: "name fehlt" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt" });

    if (isBlockedTitle(name)) {
      return res.status(400).json({ ok: false, error: "Dieses Kino ist blockiert." });
    }

    const result = await serpApiShowtimes({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler (showtimes)", details: result.data });
    }

    const showtimesArr = result.data?.showtimes || [];
    const days = normalizeShowtimes(showtimesArr);

    // OPTIONAL: für die ersten N Filme Poster/Info serverseitig anreichern,
    // aber N klein halten, sonst wird es langsam + kostet Credits.
    const MAX_ENRICH = 8;

    const uniqTitles = [];
    for (const d of days) {
      for (const m of d.movies || []) {
        if (!m.title) continue;
        if (isBlockedTitle(m.title)) continue;
        if (!uniqTitles.includes(m.title)) uniqTitles.push(m.title);
        if (uniqTitles.length >= MAX_ENRICH) break;
      }
      if (uniqTitles.length >= MAX_ENRICH) break;
    }

    // Poster + Info parallel holen
    const enrichMap = new Map();
    await Promise.all(
      uniqTitles.map(async (t) => {
        try {
          const [p, info] = await Promise.all([
            serpApiPoster({ key, title: t }),
            serpApiMovieInfo({ key, movieTitle: t }),
          ]);
          enrichMap.set(t, {
            poster: p?.ok ? p.poster : null,
            snippet: info?.snippet || null,
            link: info?.link || null,
          });
        } catch {
          enrichMap.set(t, { poster: null, snippet: null, link: null });
        }
      })
    );

    for (const d of days) {
      for (const m of d.movies || []) {
        const extra = enrichMap.get(m.title);
        if (!extra) continue;

        // nur überschreiben, wenn noch kein Poster existiert
        if (!m.poster && extra.poster) m.poster = extra.poster;

        if (!m.info?.description && extra.snippet) {
          m.info = m.info || {};
          m.info.description = extra.snippet;
        }

        if (!m.infoLink && extra.link) m.infoLink = extra.link;
      }
    }

    return res.json({
      ok: true,
      cinema: name,
      city,
      days,
      raw_has_showtimes: Array.isArray(showtimesArr) && showtimesArr.length > 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// ✅ NEU: GET /api/poster?title=...
// -> für dein Frontend: Poster nachladen, wenn "Kein Poster" angezeigt wird
// --------------------
app.get("/api/poster", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const title = (req.query.title || "").toString().trim();
    if (!title) return res.status(400).json({ ok: false, error: "title fehlt" });

    if (isBlockedTitle(title)) {
      return res.json({ ok: true, poster: null });
    }

    const result = await serpApiPoster({ key, title });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});