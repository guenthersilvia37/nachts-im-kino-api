import fetch from "node-fetch";
global.fetch = fetch;
import express from "express";
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT;

const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();
const TMDB_KEY = (process.env.TMDB_KEY || "").trim();

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
app.get("/api/health", (req, res) =>
  res.json({ ok: true, serp: Boolean(SERPAPI_KEY), tmdb: Boolean(TMDB_KEY) })
);

// --------------------
// Helpers
// --------------------
function escStr(v) {
  return String(v ?? "");
}
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// --------------------
// Blocklist: Adult / Erotik / Noise (hart)
// --------------------
const BLOCKED_WORDS = [
  "erotik",
  "sex",
  "sexy",
  "adult",
  "porno",
  "porn",
  "blue movie",
  "fkk",
  "bordell",
  "strip",
  "peepshow",
  "escort",
  "privatclub",
  "sauna club",
  "sauna",
  "massage",
  "erdbeermund",
  "kino hole",
  "hole kino",
  "sexkino",
  "adult kino",
];

function isBlockedTitle(title) {
  const t = escStr(title).toLowerCase();
  return BLOCKED_WORDS.some((w) => t.includes(w));
}

// --------------------
// Kino-Filter
// --------------------
const CINEMA_WORDS = [
  "kino",
  "kinos",
  "cinema",
  "cine",
  "movie theater",
  "movie theatre",
  "filmtheater",
  "lichtspiele",
  "filmhaus",
  "programmkino",
  "arthouse",
  "filmkunst",
  "kinocenter",
];

const CINEMA_BRANDS = [
  "cinedom",
  "cinemaxx",
  "uci",
  "cineplex",
  "cinestar",
  "kinopolis",
  "filmpalast",
  "metropolis",
];

const BAD_VENUE_WORDS = ["club", "bar", "lounge", "massage", "sauna", "bordell"];

function looksLikeCinemaByCategory(p) {
  const type = escStr(p?.type).toLowerCase();
  const category = escStr(p?.category).toLowerCase();
  return (
    type.includes("movie") ||
    type.includes("cinema") ||
    type.includes("theater") ||
    category.includes("movie") ||
    category.includes("cinema") ||
    category.includes("theater")
  );
}

function isCinemaPlace(p) {
  const title = escStr(p?.title || p?.name).toLowerCase();
  if (isBlockedTitle(title)) return false;

  const byCat = looksLikeCinemaByCategory(p);
  const byText =
    CINEMA_BRANDS.some((b) => title.includes(b)) ||
    CINEMA_WORDS.some((w) => title.includes(w));

  const looksBad = BAD_VENUE_WORDS.some((w) => title.includes(w));
  if (looksBad && !byCat && !byText) return false;

  return byCat || byText;
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
    category: p?.category || null,
    type: p?.type || null,
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
    headers: { "User-Agent": "nachts-im-kino/1.0" },
  });

  if (!r.ok) return [];
  return r.json();
}

// --------------------
// SerpApi: Google Maps (WICHTIG: location ODER ll, nie beides)
// --------------------
async function serpApiGoogleMaps({ city, lat, lon }) {
  if (!SERPAPI_KEY) {
    return { ok: false, status: 500, data: { error: "SERPAPI_KEY fehlt" } };
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("q", `Kino in ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", SERPAPI_KEY);

  // ✅ ENTWEDER ll ODER location
  if (lat != null && lon != null) {
    url.searchParams.set("ll", `@${lat},${lon},12z`);
  } else {
    url.searchParams.set("location", `${city}, Germany`);
  }

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  if (data?.error) return { ok: false, status: 500, data }; // SerpApi kann error im body liefern
  return { ok: true, status: 200, data };
}

// --------------------
// SerpApi: Showtimes Block (Google Search)
// --------------------
async function serpApiShowtimes({ cinemaName, city }) {
  if (!SERPAPI_KEY) {
    return { ok: false, status: 500, data: { error: "SERPAPI_KEY fehlt" } };
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `${cinemaName} Spielzeiten ${city}`);
  url.searchParams.set("location", `${city}, Germany`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  if (data?.error) return { ok: false, status: 500, data };
  return { ok: true, status: 200, data };
}

// --------------------
// Showtimes normalisieren
// --------------------
function normalizeShowtimes(showtimesArr) {
  const days = [];

  for (const d of showtimesArr || []) {
    const dayLabel = d?.day || "";
    const dateLabel = d?.date || "";

    const movies = [];
    for (const m of d?.movies || []) {
      const title = (m?.name || m?.title || "").trim();
      if (!title) continue;

      const times = [];
      for (const s of m?.showing || []) {
        for (const t of s?.time || []) times.push(t);
      }
      const uniqTimes = [...new Set(times)].filter(Boolean);

      movies.push({
        title,
        times: uniqTimes,
        poster: m?.thumbnail || m?.poster || null,
        info: { description: null, runtime: null, genres: [], cast: [] },
      });
    }

    days.push({ day: dayLabel, date: dateLabel, movies });
  }

  return days;
}

// --------------------
// TMDB helpers
// --------------------
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

function cleanMovieTitle(t) {
  return escStr(t)
    .replace(/\s*[–-]\s*.*$/g, "") // alles nach " – " oder " - " weg
    .replace(/\(.*?\)/g, "") // (OV), (3D)...
    .replace(/\b(ov|omu|3d|imax|dolby|atmos|df|d-?box)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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

  const [details, credits, videos, images] = await Promise.all([
    tmdbFetch(`movie/${movie.id}`),
    tmdbFetch(`movie/${movie.id}/credits`),
    tmdbFetch(`movie/${movie.id}/videos`),
    tmdbFetch(`movie/${movie.id}/images`, { include_image_language: "de,null" }),
  ]);

  const poster = movie.poster_path
    ? `https://image.tmdb.org/t/p/w342${movie.poster_path}`
    : null;

  const vids = Array.isArray(videos?.results) ? videos.results : [];
  const yt = vids.filter((v) => (v.site || "").toLowerCase() === "youtube");
  const trailer =
    yt.find((v) => v.type === "Trailer" && v.official) ||
    yt.find((v) => v.type === "Trailer") ||
    yt.find((v) => v.type === "Teaser") ||
    null;

  const trailerKey = trailer?.key || null;

  const backdrops = Array.isArray(images?.backdrops) ? images.backdrops : [];
  const posters = Array.isArray(images?.posters) ? images.posters : [];

  const imageUrls = backdrops
    .slice(0, 10)
    .map((i) => i?.file_path)
    .filter(Boolean)
    .map((p) => `https://image.tmdb.org/t/p/w780${p}`);

  const posterUrls = posters
    .slice(0, 8)
    .map((i) => i?.file_path)
    .filter(Boolean)
    .map((p) => `https://image.tmdb.org/t/p/w500${p}`);

  return {
    title: details?.title || movie?.title || title,
    poster,
    description: details?.overview || null,
    runtime: details?.runtime ? `${details.runtime} Min` : null,
    genres: (details?.genres || []).map((g) => g.name),
    cast: (credits?.cast || []).slice(0, 6).map((a) => a.name),
    trailerKey,
    images: imageUrls.length ? imageUrls : posterUrls,
  };
}

// --------------------
// In-memory cache (TMDB) - NICHT null cachen
// --------------------
const memCache = new Map(); // key -> {t,v}
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
function cacheSet(key, v) {
  if (!v) return;
  memCache.set(key, { t: Date.now(), v });
}
function tmdbCacheKey(title) {
  return `tmdb::${cleanMovieTitle(title)}`.toLowerCase();
}

// --------------------
// GET /api/cinemas?q=...
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    if (!SERPAPI_KEY) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt" });

    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    const result = await serpApiGoogleMaps({ city, lat, lon });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: "SerpApi Fehler", details: result.data });

    const raw =
      result.data?.local_results ||
      result.data?.place_results ||
      result.data?.places ||
      [];

    const cinemas = raw
      .filter(isCinemaPlace)
      .map(normalizeCinema)
      .filter((c) => c?.title && !isBlockedTitle(c.title));

    return res.json({
      ok: true,
      resolved_city: city,
      coords_used: lat != null && lon != null ? { lat, lon } : null,
      cinemas,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// GET /api/showtimes?name=...&city=...
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    if (!SERPAPI_KEY) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();
    if (!name) return res.status(400).json({ ok: false, error: "name fehlt" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt" });

    if (isBlockedTitle(name)) return res.status(400).json({ ok: false, error: "Dieses Kino ist blockiert." });

    const result = await serpApiShowtimes({ cinemaName: name, city });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: "SerpApi Fehler", details: result.data });

    const showtimesArr = result.data?.showtimes || [];
    const days = normalizeShowtimes(showtimesArr);

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
          if (cached) {
            infoMap.set(t, cached);
            return;
          }
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
      days,
      raw_has_showtimes: Array.isArray(showtimesArr) && showtimesArr.length > 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

// --------------------
// GET /api/movie?title=...
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

// --------------------
// GET /api/poster?title=...
// --------------------
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

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server läuft auf Port", PORT);
});