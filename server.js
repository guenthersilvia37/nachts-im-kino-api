import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// Keys
// --------------------
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
        link: m?.link || null,
        times: uniqTimes,
        poster: m?.thumbnail || m?.poster || null,
        info: {
          description: null,
          runtime: null,
          genres: [],
          cast: [],
        },
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
// TMDB helpers
// --------------------
async function tmdbFetch(path, params = {}) {
  if (!TMDB_KEY) return null;

  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "de-DE");

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const r = await fetch(url.toString());
  if (!r.ok) return null;
  return r.json();
}

async function tmdbMovieByTitle(title) {
  if (!TMDB_KEY || !title) return null;

  const search = await tmdbFetch("search/movie", { query: title });
  const movie = search?.results?.[0];
  if (!movie) return null;

  const [details, credits] = await Promise.all([
    tmdbFetch(`movie/${movie.id}`),
    tmdbFetch(`movie/${movie.id}/credits`),
  ]);

  return {
    poster: movie.poster_path
      ? `https://image.tmdb.org/t/p/w342${movie.poster_path}`
      : null,
    description: details?.overview || null,
    runtime: details?.runtime ? `${details.runtime} Min` : null,
    genres: (details?.genres || []).map((g) => g.name),
    cast: (credits?.cast || []).slice(0, 6).map((a) => a.name),
  };
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

    const result = await serpApiGoogleMaps({ key: SERPAPI_KEY, city, lat, lon });
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
// -> days[] + TMDB Film-Infos
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    if (!SERPAPI_KEY) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();

    if (!name) return res.status(400).json({ ok: false, error: "name fehlt" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt" });

    if (isBlockedTitle(name)) {
      return res.status(400).json({ ok: false, error: "Dieses Kino ist blockiert." });
    }

    const result = await serpApiShowtimes({ key: SERPAPI_KEY, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler (showtimes)", details: result.data });
    }

    const showtimesArr = result.data?.showtimes || [];
    const days = normalizeShowtimes(showtimesArr);

    // TMDB Enrich (limitiert)
    const MAX_ENRICH = 10;
    const uniq = [];

    for (const d of days) {
      for (const m of d.movies || []) {
        const t = (m.title || "").trim();
        if (!t) continue;
        if (!uniq.includes(t)) uniq.push(t);
        if (uniq.length >= MAX_ENRICH) break;
      }
      if (uniq.length >= MAX_ENRICH) break;
    }

    const infoMap = new Map();
    await Promise.all(
      uniq.map(async (t) => {
        infoMap.set(t, await tmdbMovieByTitle(t));
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

    return res.json({
      ok: true,
      cinema: name,
      city,
      days,
      raw_has_showtimes: Array.isArray(showtimesArr) && showtimesArr.length > 0,
      tmdb_enabled: Boolean(TMDB_KEY),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});
// ✅ NEU: GET /api/movie?title=...
// -> liefert TMDB Infos (poster, description, runtime, genres, cast)
app.get("/api/movie", async (req, res) => {
  try{
    const title = (req.query.title || "").toString().trim();
    if(!title) return res.status(400).json({ ok:false, error:"title fehlt" });

    if (!TMDB_KEY) {
      return res.status(500).json({ ok:false, error:"TMDB_KEY fehlt (in Render/ENV setzen)" });
    }

    const movie = await tmdbMovieByTitle(title);
    return res.json({ ok:true, movie: movie || null });
  }catch(e){
    return res.status(500).json({ ok:false, error:"Serverfehler", details:String(e?.message || e) });
  }
});
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});