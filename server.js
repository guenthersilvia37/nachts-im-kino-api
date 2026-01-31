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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
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

// Filtert echte Kinos raus + blockt Erotik/Noise
function isCinemaPlace(p) {
  const title = String(p?.title || "").toLowerCase();
  const type = String(p?.type || "").toLowerCase();
  const category = String(p?.category || "").toLowerCase();

  // Hard block (wenn sowas im Titel vorkommt -> raus)
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
    "erdbeermund"
  ];
  if (blockedWords.some(w => title.includes(w))) return false;

  // Kino-Signale
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
    "uci"
  ];

  const looksLikeCinemaByText = cinemaWords.some(w => title.includes(w));

  // SerpAPI google_maps liefert manchmal type/category
  const looksLikeCinemaByCategory =
    category.includes("movie") ||
    category.includes("cinema") ||
    type.includes("movie") ||
    type.includes("cinema");

  return looksLikeCinemaByText || looksLikeCinemaByCategory;
}

// Normalisiert Felder fürs Frontend
function normalizeCinema(p) {
  return {
    title: p?.title || p?.name || "Kino",
    address: p?.address || p?.full_address || "",
    rating: p?.rating ?? null,
    reviews: p?.reviews ?? null,
    // SerpAPI google_maps hat oft "place_id" oder "data_id"
    place_id: p?.place_id || p?.data_id || null,
    // Link/Website
    link: p?.link || p?.website || null,
    // Manchmal praktisch:
    gps_coordinates: p?.gps_coordinates || null,
  };
}

// --------------------
// Nominatim: PLZ/Stadt -> Geo
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
// SerpAPI: Google Maps Suche (Kinos)
// --------------------
async function serpApiGoogleMaps({ key, city, lat, lon }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("q", `Kino in ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", key);

  // Mit Koordinaten kommt "in der Nähe" deutlich zuverlässiger
  if (lat && lon) {
    url.searchParams.set("ll", `@${lat},${lon},12z`);
  }

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) return { ok: false, status: r.status, data };
  return { ok: true, status: 200, data };
}

// --------------------
// SerpAPI: Spielzeiten für ein Kino
// Idee: wir suchen gezielt nach "Spielzeiten <Kino> <Stadt> heute"
// --------------------
async function serpApiShowtimes({ key, cinemaName, city }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", `Spielzeiten ${cinemaName} ${city} heute`);
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
// API: Kinos finden (PLZ/Stadt)
// GET /api/cinemas?q=10115
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "q fehlt (z. B. ?q=10115 oder ?q=Köln)" });

    // 1) Geo
    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    // 2) SerpAPI Google Maps
    const result = await serpApiGoogleMaps({ key, city, lat, lon });
    if (!result.ok) {
      return res.status(result.status).json({ error: "SerpApi Fehler", details: result.data });
    }

    const raw =
      result.data?.local_results ||
      result.data?.place_results ||
      [];

    // 3) Filtern + normalisieren
    const cinemas = raw
      .filter(isCinemaPlace)
      .map(normalizeCinema);

    return res.json({
      ok: true,
      source: "serpapi-google_maps",
      input: q,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
      // Debug optional (wenn du es NICHT willst, lösch die Zeile)
      // raw: result.data,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Serverfehler",
      details: String(e?.message || e),
    });
  }
});

// --------------------
// API: Spielzeiten (für ein ausgewähltes Kino)
// GET /api/showtimes?name=Filmpalast%20K%C3%B6ln&city=K%C3%B6ln
// --------------------
app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "SERPAPI_KEY fehlt" });

    const name = (req.query.name || "").toString().trim();
    const city = (req.query.city || "").toString().trim();

    if (!name) return res.status(400).json({ error: "name fehlt (z. B. ?name=Filmpalast%20K%C3%B6ln)" });
    if (!city) return res.status(400).json({ error: "city fehlt (z. B. ?city=K%C3%B6ln)" });

    const result = await serpApiShowtimes({ key, cinemaName: name, city });
    if (!result.ok) {
      return res.status(result.status).json({ error: "SerpApi Fehler", details: result.data });
    }

    // Wir geben das Roh-Ergebnis zurück + nützliche Felder oben
    return res.json({
      ok: true,
      source: "serpapi-google",
      cinema: name,
      city,
      data: result.data,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Serverfehler",
      details: String(e?.message || e),
    });
  }
});

// --------------------
// Backwards compatibility (falls dein Frontend noch /api/showtimes?q= nutzt)
// -> leitet auf /api/cinemas?q= um (als JSON)
// --------------------
app.get("/api/showtimes-legacy", async (req, res) => {
  return res.status(410).json({
    error: "Dieser Endpoint ist veraltet. Bitte nutze /api/cinemas?q=… und /api/showtimes?name=…&city=…",
  });
});

// --------------------
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});