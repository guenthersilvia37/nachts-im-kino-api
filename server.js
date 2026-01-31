import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------
// Basics
// --------------------
app.disable("x-powered-by");

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

// Erotik/Noise sicher entfernen + „echte Kinos“ erkennen
function isCinemaPlace(p) {
  const title = String(p?.title || "").toLowerCase();
  const type = String(p?.type || "").toLowerCase();
  const category = String(p?.category || "").toLowerCase();

  const blockedWords = [
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
  if (blockedWords.some((w) => title.includes(w))) return false;

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

// fetch mit Timeout (damit Render nicht hängt)
async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 599, data: { message: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

// --------------------
// Nominatim: PLZ/Stadt -> Geo
// --------------------
async function nominatimSearch(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=" +
    encodeURIComponent(q);

  const r = await fetchJson(
    url,
    { headers: { "User-Agent": "nachts-im-kino/1.0 (render)" } },
    12000
  );

  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data;
}

// --------------------
// SerpAPI: Google Maps Suche (Kinos)
// --------------------
async function serpApiGoogleMaps({ key, city, lat, lon }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("q", `Kino in ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", key);

  // Koordinaten erhöhen Trefferquote
  if (lat && lon) {
    url.searchParams.set("ll", `@${lat},${lon},12z`);
  }

  return fetchJson(url.toString(), {}, 20000);
}

// --------------------
// SerpAPI: Google Movies (Spielzeiten)
// -> tbm=mv sorgt dafür, dass SerpApi i.d.R. movie_results/showtimes liefert
// --------------------
async function serpApiShowtimesMovies({ key, cinemaName, city }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("tbm", "mv"); // ✅ Movies / Showtimes
  url.searchParams.set("q", `showtimes ${cinemaName} ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("api_key", key);

  return fetchJson(url.toString(), {}, 20000);
}

// Spielzeiten normalisieren (was SerpApi liefert, kann variieren)
function normalizeMovies(data) {
  const movies =
    data?.movie_results ||
    data?.movies_results ||
    data?.showtimes ||
    [];

  // Versuche, auf ein einheitliches Format zu bringen:
  // [{ title, showtimes:[{time}], ... }]
  if (!Array.isArray(movies)) return [];

  return movies.map((m) => {
    const showtimes = Array.isArray(m?.showtimes)
      ? m.showtimes.map((s) => ({
          time: s?.time || s?.start_time || s?.datetime || null,
          link: s?.link || null,
        }))
      : [];

    return {
      title: m?.title || m?.name || "Film",
      poster: m?.thumbnail || m?.image || null,
      showtimes,
      // optional:
      raw: undefined, // absichtlich nicht voll ausgeben
    };
  });
}

// --------------------
// API: Kinos finden
// GET /api/cinemas?q=10115
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt (z. B. ?q=10115 oder ?q=Köln)" });

    // 1) Geo
    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    // 2) SerpAPI Google Maps
    const result = await serpApiGoogleMaps({ key, city, lat, lon });
    if (!result.ok) {
      return res.status(result.status || 500).json({
        ok: false,
        error: "SerpApi Fehler (google_maps)",
        details: result.data,
      });
    }

    const raw = result.data?.local_results || result.data?.place_results || [];
    const cinemas = Array.isArray(raw)
      ? raw.filter(isCinemaPlace).map(normalizeCinema)
      : [];

    return res.json({
      ok: true,
      source: "serpapi-google_maps",
      input: q,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Serverfehler",
      details: String(e?.message || e),
    });
  }
});

// --------------------
// API: Spielzeiten
// GET /api/showtimes?name=Filmpalast%20K%C3%B6ln&city=K%C3%B6ln
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    // ✅ Zwei Modi:
    // A) neu: name + city => echte Spielzeiten
    // B) alt: q => Kino-Suche (Kompatibilität)
    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();
    const q = (req.query.q || "").toString().trim();

    // --- B) Legacy: /api/showtimes?q=Köln -> gib Kinos zurück ---
    if (!name && q) {
      // gleiche Logik wie /api/cinemas
      const geo = await nominatimSearch(q);
      if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

      const resolvedCity = pickCity(geo[0], q);
      const lat = toNumber(geo[0].lat);
      const lon = toNumber(geo[0].lon);

      const result = await serpApiGoogleMaps({ key, city: resolvedCity, lat, lon });
      if (!result.ok) {
        return res.status(result.status || 500).json({
          ok: false,
          error: "SerpApi Fehler (google_maps)",
          details: result.data,
        });
      }

      const raw = result.data?.local_results || result.data?.place_results || [];
      const cinemas = Array.isArray(raw)
        ? raw.filter(isCinemaPlace).map(normalizeCinema)
        : [];

      return res.json({
        ok: true,
        mode: "legacy-cinemas",
        source: "serpapi-google_maps",
        input: q,
        resolved_city: resolvedCity,
        cinemas,
      });
    }

    // --- A) Neu: name+city -> Spielzeiten ---
    if (!name) return res.status(400).json({ ok: false, error: "name fehlt (z. B. ?name=Filmpalast%20Köln)" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt (z. B. ?city=Köln)" });

    const result = await serpApiShowtimesMovies({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status || 500).json({
        ok: false,
        error: "SerpApi Fehler (movies/showtimes)",
        details: result.data,
      });
    }

    const movies = normalizeMovies(result.data);

    return res.json({
      ok: true,
      source: "serpapi-movies",
      cinema: name,
      city,
      movies,
      // falls du debug brauchst, kannst du raw wieder aktivieren:
      // raw: result.data,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Serverfehler",
      details: String(e?.message || e),
    });
  }
});

// --------------------
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});