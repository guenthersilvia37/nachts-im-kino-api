// server.js (Overpass + Playwright, SerpApi komplett raus)
import express from "express";
import dotenv from "dotenv";


if (process.env.NODE_ENV !== "production") dotenv.config();

const app = express();

const TMDB_KEY = (process.env.TMDB_KEY || "").trim();
const PORT = Number(process.env.PORT) || 3000;

// Wichtig für Nominatim/Overpass: vernünftiger User-Agent + Kontakt
const UA = "nachts-im-kino/1.0 (contact: you@example.com)";

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

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
app.get("/", (req, res) => res.send("ok"));
app.get("/api/health", (req, res) =>
  res.json({ ok: true, overpass: true, tmdb: Boolean(TMDB_KEY) })
);

// --------------------
// Utils
// --------------------
function escStr(v) { return String(v ?? ""); }
function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pickCity(geoItem, fallback) {
  const a = geoItem?.address || {};
  return (
    a.city || a.town || a.village || a.municipality || a.county ||
    geoItem?.display_name?.split(",")?.[0] || fallback
  );
}

// --------------------
// Blocklist
// --------------------
const BLOCKED_WORDS = [
  "erotik","sex","sexy","adult","porno","porn","blue movie","fkk","bordell","strip","peepshow",
  "escort","privatclub","sauna club","sauna","massage","erdbeermund","kino hole","hole kino",
  "sexkino","adult kino",
];
function isBlockedTitle(title) {
  const t = escStr(title).toLowerCase();
  return BLOCKED_WORDS.some((w) => t.includes(w));
}

// --------------------
// Nominatim
// --------------------
async function nominatimSearch(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=" +
    encodeURIComponent(q);

  const r = await fetch(url, {
    headers: {
      // wichtig: Nominatim will eine identifizierbare Anfrage
      "User-Agent": "nachts-im-kino/1.0 (contact: guenther_silvia@web.de)",
      "Accept-Language": "de",
      "From": "guenther_silvia@web.de",
    },
  });

  if (!r.ok) {
    console.log("Nominatim Fehler Status:", r.status);
    const txt = await r.text().catch(() => "");
    console.log("Nominatim Body:", txt.slice(0, 200));
    return [];
  }

  return r.json();
}

// --------------------
// Overpass
// --------------------
async function overpassCinemas({ lat, lon, radiusMeters = 12000 }) {
  const endpoint = "https://overpass-api.de/api/interpreter";
  const query = `
[out:json][timeout:25];
(
  node["amenity"="cinema"](around:${radiusMeters},${lat},${lon});
  way["amenity"="cinema"](around:${radiusMeters},${lat},${lon});
  relation["amenity"="cinema"](around:${radiusMeters},${lat},${lon});
);
out center tags;
  `.trim();

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: "data=" + encodeURIComponent(query),
  });

  if (!r.ok) return { ok: false, status: r.status, data: null };
  const data = await r.json().catch(() => null);
  return { ok: true, status: 200, data };
}

function osmAddressFromTags(tags) {
  const t = tags || {};
  const parts = [];
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const cityLine = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
  if (street) parts.push(street);
  if (cityLine) parts.push(cityLine);

  if (!parts.length) {
    const alt = [t["contact:street"], t["contact:housenumber"]].filter(Boolean).join(" ");
    const altCity = [t["contact:postcode"], t["contact:city"]].filter(Boolean).join(" ");
    if (alt) parts.push(alt);
    if (altCity) parts.push(altCity);
  }
  return parts.join(", ");
}

function osmWebsiteFromTags(tags) {
  const t = tags || {};
  return t.website || t.url || t["contact:website"] || t["contact:url"] || null;
}

function normalizeCinemaOSM(el) {
  const tags = el?.tags || {};
  const title = tags.name || tags["name:de"] || "Kino";

  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;

  return {
    title,
    address: osmAddressFromTags(tags),
    rating: null,
    reviews: null,
    place_id: `${el.type || "osm"}_${el.id || ""}`,
    link: osmWebsiteFromTags(tags),
    gps_coordinates: (lat != null && lon != null) ? { latitude: lat, longitude: lon } : null,
    category: "amenity=cinema",
    type: "Kino",
  };
}

// Cache Overpass
const cinemaCache = new Map();
const CINEMA_CACHE_MS = 1000 * 60 * 10;

function cacheGetCinema(key) {
  const e = cinemaCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CINEMA_CACHE_MS) {
    cinemaCache.delete(key);
    return null;
  }
  return e.v;
}
function cacheSetCinema(key, v) { cinemaCache.set(key, { t: Date.now(), v }); }

// --------------------
// Showtimes helpers
// --------------------
function ensureSevenDays(days) {
  const now = new Date();
  const want = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    want.push({
      day: d.toLocaleDateString("de-DE", { weekday: "short" }),
      date: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      movies: [],
    });
  }

  const byDate = new Map();
  (days || []).forEach((x) => {
    const key = escStr(x?.date || "").trim();
    if (key) byDate.set(key, x);
  });

  return want.map((w) => {
    const found = byDate.get(w.date);
    if (!found) return w;
    return {
      day: found.day || w.day,
      date: found.date || w.date,
      movies: Array.isArray(found.movies) ? found.movies : [],
    };
  });
}

function countRealDays(daysArr) {
  return (daysArr || []).filter(
    (d) =>
      Array.isArray(d.movies) &&
      d.movies.some((m) => Array.isArray(m.times) && m.times.length > 0)
  ).length;
}

// --------------------
// TMDB (wie bei dir)
// --------------------
function cleanMovieTitle(t) {
  return escStr(t)
    .replace(/\s*[–-]\s*.*$/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(ov|omu|3d|imax|dolby|atmos|df|d-?box)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function tmdbFetch(path, params = {}) {
  if (!TMDB_KEY) return null;
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "de-DE");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const r = await fetch(url.toString());
  if (!r.ok) return null;
  return r.json();
}

async function tmdbSearchBestMatch(rawTitle) {
  if (!TMDB_KEY) return null;
  const variants = [];
  const a = escStr(rawTitle).trim();
  const b = cleanMovieTitle(a);
  if (a) variants.push(a);
  if (b && b !== a) variants.push(b);
  if (b.includes(":")) variants.push(b.split(":")[0].trim());

  for (const q of variants) {
    const search = await tmdbFetch("search/movie", { query: q });
    const movie = search?.results?.[0];
    if (movie?.id) return movie;
  }
  return null;
}

async function tmdbMovieByTitle(title) {
  if (!TMDB_KEY || !title) return null;

  const movie = await tmdbSearchBestMatch(title);
  if (!movie?.id) return null;

  const [details, credits] = await Promise.all([
    tmdbFetch(`movie/${movie.id}`),
    tmdbFetch(`movie/${movie.id}/credits`),
  ]);

  const poster = movie.poster_path ? `https://image.tmdb.org/t/p/w342${movie.poster_path}` : null;

  return {
    title: details?.title || movie?.title || title,
    poster,
    description: details?.overview || null,
    runtime: details?.runtime ? `${details.runtime} Min` : null,
    genres: (details?.genres || []).map((g) => g.name),
    cast: (credits?.cast || []).slice(0, 6).map((a) => a.name),
  };
}

const memCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 12;

function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    memCache.delete(key);
    return undefined;
  }
  return e.v;
}
function cacheSet(key, v) { if (v) memCache.set(key, { t: Date.now(), v }); }
function tmdbCacheKey(title) { return `tmdb::${cleanMovieTitle(title)}`.toLowerCase(); }

// --------------------
// GET /api/cinemas
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt" });

    const cacheKey = q.toLowerCase();
    const cached = cacheGetCinema(cacheKey);
    if (cached) return res.json(cached);

    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);
    if (lat == null || lon == null) return res.status(500).json({ ok: false, error: "Koordinaten fehlen" });

    const result = await overpassCinemas({ lat, lon, radiusMeters: 15000 });
    if (!result.ok)
      return res.status(result.status).json({ ok: false, error: "Overpass Fehler", details: result.data });

    const els = result.data?.elements || [];
    const cinemas = els
      .map(normalizeCinemaOSM)
      .filter((c) => c?.title && !isBlockedTitle(c.title));

    const payload = { ok: true, resolved_city: city, coords_used: { lat, lon }, cinemas };
    cacheSetCinema(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// GET /api/showtimes
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();
    const url = (req.query.url || "").toString().trim();

    if (!name) return res.status(400).json({ ok: false, error: "name fehlt" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt" });
    if (isBlockedTitle(name)) return res.status(400).json({ ok: false, error: "Dieses Kino ist blockiert." });

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.json({
        ok: false,
        cinema: name,
        city,
        url: null,
        days: ensureSevenDays([]),
        real_days_found: 0,
        error: "Keine Website-URL für dieses Kino vorhanden.",
      });
    }

    let days = [];
let pwDebug = null;

    days = ensureSevenDays(days);
    const realDays = countRealDays(days);

    // Wenn Playwright nichts findet → ok:false damit Frontend sauber reagieren kann
    if (realDays === 0) {
  return res.json({
    ok: false,
    cinema: name,
    city,
    url,
    days,
    real_days_found: 0,
    error: "Keine Spielzeiten auf der Seite gefunden (oder Seite blockt Scraping).",
    debug: pwDebug, // ✅ NEU
  });
}
    // Optional TMDB enrich
    if (TMDB_KEY) {
      const MAX_ENRICH = 12;
      const uniqTitles = [];

      for (const d of days) {
        for (const m of d.movies || []) {
          const t = (m.title || "").trim();
          if (!t) continue;
          if (isBlockedTitle(t)) continue;
          if (!uniqTitles.includes(t)) uniqTitles.push(t);
          if (uniqTitles.length >= MAX_ENRICH) break;
        }
        if (uniqTitles.length >= MAX_ENRICH) break;
      }

      const infoMap = new Map();
      await Promise.all(
        uniqTitles.map(async (t) => {
          const ck = tmdbCacheKey(t);
          const cached = cacheGet(ck);
          if (cached) { infoMap.set(t, cached); return; }
          const info = await tmdbMovieByTitle(t);
          if (info) cacheSet(ck, info);
          infoMap.set(t, info || null);
        })
      );

      for (const d of days) {
        for (const m of d.movies || []) {
          const info = infoMap.get((m.title || "").trim());
          if (!info) continue;
          if (!m.poster && info.poster) m.poster = info.poster;
          m.info = {
            description: info.description || null,
            runtime: info.runtime || null,
            genres: info.genres || [],
            cast: info.cast || [],
          };
        }
      }
    }

    return res.json({
  ok: true,
  cinema: name,
  city,
  url,
  days,
  real_days_found: realDays,
  debug: pwDebug,
});
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// /api/movie + /api/poster (wie gehabt)
// --------------------
app.get("/api/movie", async (req, res) => {
  try {
    const title = (req.query.title || "").toString().trim();
    if (!title) return res.status(400).json({ ok: false, error: "title fehlt" });
    if (isBlockedTitle(title)) return res.json({ ok: true, movie: null, reason: "blocked" });
    if (!TMDB_KEY) return res.json({ ok: true, movie: null, reason: "tmdb_key_missing" });

    const ck = tmdbCacheKey(title);
    const cached = cacheGet(ck);
    if (cached) return res.json({ ok: true, movie: cached });

    const movie = await tmdbMovieByTitle(title);
    if (movie) cacheSet(ck, movie);

    return res.json({ ok: true, movie: movie || null, reason: movie ? null : "not_found" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.get("/api/poster", async (req, res) => {
  try {
    const title = (req.query.title || "").toString().trim();
    if (!title) return res.status(400).json({ ok: false, error: "title fehlt" });
    if (isBlockedTitle(title)) return res.json({ ok: true, poster: null });
    if (!TMDB_KEY) return res.json({ ok: true, poster: null, reason: "tmdb_key_missing" });

    const ck = tmdbCacheKey(title);
    const cached = cacheGet(ck);
    if (cached?.poster) return res.json({ ok: true, poster: cached.poster });

    const movie = await tmdbMovieByTitle(title);
    if (movie) cacheSet(ck, movie);

    return res.json({ ok: true, poster: movie?.poster || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server läuft auf Port", PORT);
});