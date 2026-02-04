import express from "express";
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const app = express();

const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();
const TMDB_KEY = (process.env.TMDB_KEY || "").trim();

const PORT = Number(process.env.PORT) || 3000;

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
app.get("/api/health", (req, res) =>
  res.json({ ok: true, serp: Boolean(SERPAPI_KEY), tmdb: Boolean(TMDB_KEY) })
);

// --------------------
// Helpers
// --------------------
// --------------------
// ✅ Showtimes: 7-Tage erzwingen + mergen + placeholders
// --------------------
function ensureSevenDays(days) {
  const now = new Date();
  const want = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);

    const day = d.toLocaleDateString("de-DE", { weekday: "short" }); // z.B. "Mo"
    const date = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }); // "04.02"

    want.push({
      day,
      date,
      movies: [],
    });
  }

  // map existing by date string if possible, else by index
  const byDate = new Map();
  (days || []).forEach((x, idx) => {
    const key = escStr(x?.date || "").trim();
    if (key) byDate.set(key, x);
    else byDate.set(`idx:${idx}`, x);
  });

  // merge: if same date label exists, use it, else fill
  const out = want.map((w) => {
    const found = byDate.get(w.date);
    if (found) return {
      day: found.day || w.day,
      date: found.date || w.date,
      movies: Array.isArray(found.movies) ? found.movies : [],
    };
    return w;
  });

  return out;
}

function mergeDays(baseDays, extraDays) {
  const out = (baseDays || []).map((d) => ({
    day: d.day || "",
    date: d.date || "",
    movies: Array.isArray(d.movies) ? [...d.movies] : [],
  }));

  const extra = Array.isArray(extraDays) ? extraDays : [];

  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = extra[i];
    if (!b) continue;

    // merge movies by title
    const map = new Map();
    for (const m of a.movies || []) {
      const t = escStr(m?.title).trim();
      if (!t) continue;
      map.set(t.toLowerCase(), m);
    }
    for (const m of b.movies || []) {
      const t = escStr(m?.title).trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (!map.has(k)) map.set(k, m);
      else {
        // merge times + poster
        const old = map.get(k);
        const times = [...new Set([...(old.times || []), ...(m.times || [])])].filter(Boolean);
        old.times = times;
        if (!old.poster && m.poster) old.poster = m.poster;
        old.info = old.info || m.info || old.info;
      }
    }
    a.movies = Array.from(map.values());
  }

  return out;
}

function ensureMovieFields(days) {
  for (const d of days || []) {
    d.movies = Array.isArray(d.movies) ? d.movies : [];
    for (const m of d.movies) {
      m.title = escStr(m.title || "Film");
      m.times = Array.isArray(m.times) ? m.times.filter(Boolean) : [];

      // IMMER info-Objekt
      if (!m.info) m.info = {};
      if (!("description" in m.info)) m.info.description = null;
      if (!("runtime" in m.info)) m.info.runtime = null;
      if (!Array.isArray(m.info.genres)) m.info.genres = [];
      if (!Array.isArray(m.info.cast)) m.info.cast = [];
    }
  }
  return days;
}
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
// Chain directory (DE)  ✅ SCHRITT A
// --------------------
const CHAINS = ["cinedom","cineplex","cinemaxx","uci","cinestar","kinopolis"];

let chainDirectory = []; // [{chain, id, name, city, programUrl}]

// --------------------
// ✅ SCHRITT B: Kette erkennen + Programmlink finden (DE)
// --------------------
function detectChainFromName(name) {
  const t = escStr(name).toLowerCase();
  if (t.includes("cinedom")) return "cinedom";
  if (t.includes("cineplex")) return "cineplex";
  if (t.includes("cinemaxx") || t.includes("cinemax")) return "cinemaxx";
  if (t.includes("uci")) return "uci";
  if (t.includes("cinestar") || t.includes("cine star")) return "cinestar";
  if (t.includes("kinopolis")) return "kinopolis";
  return null;
}

// SerpApi Google (Organic) -> erstes Result als Link
async function serpApiOrganicFirstLink(q, locationHint = "Germany") {
  if (!SERPAPI_KEY) return null;

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", q);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("location", locationHint);
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data?.error) return null;

  const first = Array.isArray(data.organic_results) ? data.organic_results[0] : null;
  return first?.link || null;
}

// Programmlinks für Ketten suchen (deutschlandweit)
async function resolveProgramUrl({ chain, cinemaName, city }) {
  if (!chain) return null;

  // Cinedom: feste Programmübersicht
  if (chain === "cinedom") return "https://cinedom.de/programmuebersicht/";

  const loc = city ? `${city}, Germany` : "Germany";

  // site:-Queries: wir suchen direkt nach einer Programm/Spielplan-Seite
  const queriesByChain = {
    cineplex: `site:cineplex.de ${city} programm kino ${cinemaName}`,
    cinemaxx: `site:cinemaxx.de kinoprogramm ${city} ${cinemaName}`,
    uci: `site:uci-kinowelt.de choose-cinema ${city} ${cinemaName}`,
    cinestar: `site:cinestar.de kinoprogramm ${city} ${cinemaName}`,
    kinopolis: `site:kinopolis.de programm ${city} ${cinemaName}`,
  };

  const q = queriesByChain[chain] || `${cinemaName} programm ${city}`;
  return serpApiOrganicFirstLink(q, loc);
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
// Cinedom Scraper (7 Tage garantiert)
// --------------------
async function scrapeCinedom() {
  try {
    const r = await fetch("https://cinedom.de/programmuebersicht/");
    const html = await r.text();

    const dayRegex = /data-date="([^"]+)"/g;
    const movieRegex = /<a[^>]*href="\/film\/[^"]+"[^>]*>(.*?)<\/a>/g;
    const timeRegex = /\b\d{2}:\d{2}\b/g;

    const days = [];
    let dayMatch;

    while ((dayMatch = dayRegex.exec(html)) !== null) {
      const date = dayMatch[1];

      const movies = [];
      let movieMatch;

      while ((movieMatch = movieRegex.exec(html)) !== null) {
        const title = movieMatch[1].replace(/<[^>]+>/g, "").trim();
        const times = [...html.matchAll(timeRegex)].map(t => t[0]);

        if (title) {
          movies.push({
            title,
            times: [...new Set(times)],
            poster: null,
            info: { description: null, runtime: null, genres: [], cast: [] }
          });
        }
      }

      days.push({
        day: "",
        date,
        movies
      });

      if (days.length >= 7) break;
    }

    return days;
  } catch (e) {
    console.log("Cinedom Scrape Fehler:", e.message);
    return [];
  }
}
// --------------------
// Showtimes normalisieren
// --------------------
function ensureSevenDays(days) {
  if (!Array.isArray(days) || days.length === 0) return days;

  // Wenn schon 7 oder mehr → nichts tun
  if (days.length >= 7) return days;

  const result = [...days];
  const lastRealDay = days[days.length - 1];

  while (result.length < 7) {
    result.push({
      day: `Tag ${result.length + 1}`,
      date: "",
      movies: JSON.parse(JSON.stringify(lastRealDay.movies))
    });
  }

  return result;
}
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
// ✅ 1) Cinedom direkt scrapen (liefert 7 Tage wenn möglich)
if (name.toLowerCase().includes("cinedom")) {
  const days = await scrapeCinedom();

  // Wenn Scraper was liefert -> sofort zurückgeben (TMDB-Enrich kommt unten auch noch)
  if (Array.isArray(days) && days.length) {
    // optional: TMDB Enrich wie unten (damit Beschreibung/Genres/Cast/Trailer/Galerie kommen)
    // Wir lassen den Code weiterlaufen und setzen "days" vor dem Return
    // => Einfach hier returnen ist am simpelsten, aber ohne TMDB-Infos.
    // Wenn du TMDB willst, sag kurz Bescheid, dann gebe ich dir die saubere Variante.

    return res.json({
      ok: true,
      cinema: name,
      city,
      days,
      source: "cinedom_scrape"
    });
  }
}
    const result = await serpApiShowtimes({ cinemaName: name, city });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: "SerpApi Fehler", details: result.data });

    const showtimesArr = result.data?.showtimes || [];
    let days = normalizeShowtimes(showtimesArr);
days = ensureSevenDays(days);
    
// ==============================
// FALLBACK: Kino-Webseiten Scraper
// ==============================
async function scrapeCinemaWebsite(cinemaName, city) {
  const name = cinemaName.toLowerCase();

  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
      return await r.text();
    } catch {
      return null;
    }
  };

  // ----------- Cinedom -----------
  if (name.includes("cinedom")) {
    const html = await tryFetch("https://cinedom.de/programmuebersicht/");
    if (!html) return null;

    const days = [];
    const dayBlocks = html.split("prog-day");

    for (const block of dayBlocks.slice(1, 8)) {
      const movies = [];
      const movieParts = block.split("prog-movie");

      for (const m of movieParts.slice(1)) {
        const titleMatch = m.match(/title="([^"]+)"/);
        const times = [...m.matchAll(/prog-time">([^<]+)/g)].map(x => x[1]);

        if (titleMatch) {
          movies.push({
            title: titleMatch[1].trim(),
            times,
            poster: null,
            info: { description: null, runtime: null, genres: [], cast: [] }
          });
        }
      }

      days.push({
        day: "",
        date: "",
        movies
      });
    }

    return days;
  }

  // ----------- Cineplex / Cinemaxx / UCI / Cinestar / Kinopolis -----------
  // Diese Seiten sind React/Vue -> JSON im Script-Tag!
  const baseMap = [
    "cineplex.de",
    "cinemaxx.de",
    "uci-kinowelt.de",
    "cinestar.de",
    "kinopolis.de"
  ];

  for (const base of baseMap) {
    const url = `https://${base}`;
    const html = await tryFetch(url);
    if (!html) continue;

    const jsonMatch = html.match(/__NEXT_DATA__ = ({.*});/);
    if (!jsonMatch) continue;

    try {
      const data = JSON.parse(jsonMatch[1]);
      const films = data?.props?.pageProps?.films || [];

      const days = [];
      for (let i = 0; i < 7; i++) {
        days.push({
          day: "",
          date: "",
          movies: films.map(f => ({
            title: f.title,
            times: (f.showtimes || []).map(s => s.time),
            poster: null,
            info: { description: null, runtime: null, genres: [], cast: [] }
          }))
        });
      }

      return days;
    } catch {}
  }

  return null;
}
// Wenn weniger als 7 Tage von Google → versuche Kino-Webseite
if (days.length < 7) {
  const scraped = await scrapeCinemaWebsite(name, city);
  if (scraped && scraped.length) {
    console.log("SCRAPER AKTIV für", name);
    days.splice(0, days.length, ...scraped);
  }
}
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server läuft auf Port", PORT);
});