import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();
const TMDB_KEY = (process.env.TMDB_KEY || "").trim();

// --------------------
// ✅ fetch Fix (Node < 18)
// --------------------
let _fetch = globalThis.fetch;
if (!_fetch) {
  try {
    const mod = await import("node-fetch");
    _fetch = mod.default;
    console.log("✅ node-fetch geladen (Node < 18)");
  } catch (e) {
    console.error("❌ Kein fetch verfügbar. Installiere node-fetch:", e);
  }
}

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
// Blocklist
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

  const r = await _fetch(url, {
    headers: { "User-Agent": "nachts-im-kino/1.0 (render)" },
  });

  if (!r.ok) return [];
  return r.json();
}

// --------------------
// SerpApi: Google Maps (Kinos)
// ✅ FIX: type=search + location ist wichtig
// --------------------
async function serpApiGoogleMaps({ city, lat, lon }) {
  if (!SERPAPI_KEY) return { ok: false, status: 500, data: { error: "SERPAPI_KEY fehlt" } };

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("type", "search");
  url.searchParams.set("q", "Kino"); // kurz + stabil
  url.searchParams.set("location", `${city}, Germany`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", SERPAPI_KEY);

  // ll macht manchmal Probleme -> nur setzen, wenn wir beide sauber haben
  if (lat != null && lon != null) {
    url.searchParams.set("ll", `@${lat},${lon},13z`);
  }

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  // ⚠️ SerpApi liefert Fehler oft als JSON-Feld "error" obwohl HTTP 200 ist
  const serpError =
    data?.error ||
    data?.search_metadata?.status === "Error" ||
    data?.search_metadata?.status === "Failure";

  if (!r.ok || serpError) {
    return {
      ok: false,
      status: r.status || 500,
      data,
    };
  }

  return { ok: true, status: 200, data };
}

// --------------------
// ✅ DEBUG Endpoint (zeigt dir exakt, was SerpApi liefert)
// --------------------
app.get("/api/debug/cinemas", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim() || "Köln";

    const geo = await nominatimSearch(q);
    const city = geo.length ? pickCity(geo[0], q) : q;
    const lat = geo.length ? toNumber(geo[0].lat) : null;
    const lon = geo.length ? toNumber(geo[0].lon) : null;

    const result = await serpApiGoogleMaps({ city, lat, lon });
    const data = result.data || {};

    // mögliche Felder
    const rawCandidates = {
      local_results: data?.local_results,
      place_results: data?.place_results,
      places: data?.places,
    };

    const pickAny =
      data?.local_results ||
      data?.place_results ||
      data?.places ||
      [];

    const arr = Array.isArray(pickAny) ? pickAny : [];
    const sample = arr[0] || null;

    res.json({
      ok: true,
      serp_ok: result.ok,
      serp_status: result.status,
      city,
      keys: Object.keys(data || {}),
      candidates_types: {
        local_results: Array.isArray(rawCandidates.local_results) ? "array" : typeof rawCandidates.local_results,
        place_results: Array.isArray(rawCandidates.place_results) ? "array" : typeof rawCandidates.place_results,
        places: Array.isArray(rawCandidates.places) ? "array" : typeof rawCandidates.places,
      },
      raw_count: arr.length,
      sample_title: sample?.title || sample?.name || null,
      sample_category: sample?.category || null,
      sample_type: sample?.type || null,
      sample_full: sample,
      note:
        "Wenn raw_count 0 ist: SerpApi liefert nichts (Quota/Location/Key). Wenn raw_count >0 aber cinemas 0 -> Filter zu streng.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// GET /api/cinemas?q=...
// --------------------
app.get("/api/cinemas", async (req, res) => {
  try {
    if (!SERPAPI_KEY)
      return res.status(500).json({ ok: false, error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q fehlt" });

    const geo = await nominatimSearch(q);
    if (!geo.length)
      return res.status(404).json({ ok: false, error: "Ort nicht gefunden" });

    const city = pickCity(geo[0], q);
    const lat = toNumber(geo[0].lat);
    const lon = toNumber(geo[0].lon);

    const result = await serpApiGoogleMaps({ city, lat, lon });
    if (!result.ok)
      return res
        .status(result.status)
        .json({ ok: false, error: "SerpApi Fehler", details: result.data });

    const data = result.data || {};

    const raw =
      data?.local_results ||
      data?.place_results ||
      data?.places ||
      [];

    const rawArr = Array.isArray(raw) ? raw : [];

    const cinemas = rawArr
      .filter(isCinemaPlace)
      .map(normalizeCinema)
      .filter((c) => c?.title && !isBlockedTitle(c.title));

    return res.json({
      ok: true,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,
      cinemas,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});