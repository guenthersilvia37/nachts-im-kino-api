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

// Blockliste (Erotik/Noise)
const BLOCKED_WORDS = [
  "erotik",
  "sex",
  "sextoy",
  "adult",
  "bordell",
  "strip",
  "sauna club",
  "saunaclub",
  "massage",
  "escort",
  "erdbeermund",
  "lovehotel",
  "swinger",
];

function isCinemaPlace(p) {
  const title = String(p?.title || p?.name || "").toLowerCase();
  const type = String(p?.type || "").toLowerCase();
  const category = String(p?.category || "").toLowerCase();

  if (BLOCKED_WORDS.some((w) => title.includes(w))) return false;

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

// Nur “sichere” Showtimes-Items fürs Frontend
function normalizeShowtimeItems(serpData) {
  // Manche SerpApi Antworten enthalten spezielle Felder – wenn vorhanden, nimm die:
  const maybeMovie = serpData?.movie_results || serpData?.showtimes || null;
  if (Array.isArray(maybeMovie) && maybeMovie.length) {
    return maybeMovie.slice(0, 10).map((x) => ({
      title: x?.title || "Spielzeit",
      link: x?.link || x?.showtimes_link || null,
      snippet: x?.snippet || x?.showtimes || "",
      source: "movie_results",
    }));
  }

  // Fallback: organische Treffer (funktioniert zuverlässig)
  const organic = serpData?.organic_results || [];
  return organic.slice(0, 10).map((r) => ({
    title: r?.title || "Treffer",
    link: r?.link || null,
    snippet: r?.snippet || "",
    source: "organic_results",
  }));
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

  if (lat && lon) {
    url.searchParams.set("ll", `@${lat},${lon},12z`);
  }

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
}

// --------------------
// SerpApi: Google Search (Spielzeiten)  ✅ OHNE tbm
// --------------------
async function serpApiShowtimes({ key, cinemaName, city }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");

  // Query so gebaut, dass häufig kino.de / Kinoseiten / Google-Showtimes kommen:
  url.searchParams.set(
    "q",
    `Spielzeiten ${cinemaName} ${city} heute kino`
  );

  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("google_domain", "google.de");
  url.searchParams.set("num", "10");
  url.searchParams.set("api_key", key);

  // WICHTIG: KEIN tbm=mv (das ist unsupported)
  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
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
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt" });

    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    const result = await serpApiGoogleMaps({ key, city, lat, lon });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler (maps)", details: result.data });
    }

    const raw = result.data?.local_results || result.data?.place_results || [];
    const cinemas = raw.filter(isCinemaPlace).map(normalizeCinema);

    return res.json({
      ok: true,
      input: q,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
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

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();

    if (!name) return res.status(400).json({ ok: false, error: "name fehlt" });
    if (!city) return res.status(400).json({ ok: false, error: "city fehlt" });

    // Extra Safety: wenn jemand “Erdbeermund …” als Kino übergibt -> blocken
    const lower = name.toLowerCase();
    if (BLOCKED_WORDS.some((w) => lower.includes(w))) {
      return res.status(400).json({ ok: false, error: "Ungültiges Kino (blockiert)" });
    }

    const result = await serpApiShowtimes({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: "SerpApi Fehler (showtimes)", details: result.data });
    }

    const items = normalizeShowtimeItems(result.data);

    return res.json({
      ok: true,
      cinema: name,
      city,
      items,       // <- Das nutzt dein Frontend
      raw: result.data, // <- nur zum Debuggen; wenn du’s nicht willst: löschen
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});