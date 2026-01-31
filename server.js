import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS (damit deine Website die API nutzen darf) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Health ---
app.get("/api/health", (req, res) => res.json({ ok: true }));

// --- Nominatim (PLZ/Stadt -> Koordinaten) ---
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

// --- SerpApi Google Maps: Kinos finden ---
async function serpApiGoogleMaps({ key, city, lat, lon }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("q", `Kino in ${city}`);
  url.searchParams.set("hl", "de");
  url.searchParams.set("gl", "de");
  url.searchParams.set("api_key", key);

  // Super wichtig: mit Koordinaten wird es "in deiner Nähe" und liefert viel häufiger Ergebnisse
  if (lat && lon) {
    url.searchParams.set("ll", `@${lat},${lon},12z`);
  }

  const r = await fetch(url.toString());
  const data = await r.json().catch(() => null);

  if (!r.ok) {
    return { ok: false, status: r.status, data };
  }

  return { ok: true, status: 200, data };
}

// --- API Endpoint ---
app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "q fehlt (z. B. ?q=10115 oder ?q=Köln)" });

    // 1) Ort/PLZ -> Nominatim
    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ error: "Ort nicht gefunden" });

    const a = geo[0].address || {};
    const city =
      a.city ||
      a.town ||
      a.village ||
      a.municipality ||
      a.county ||
      geo[0].display_name?.split(",")?.[0] ||
      q;

    const lat = geo[0].lat ? Number(geo[0].lat) : null;
    const lon = geo[0].lon ? Number(geo[0].lon) : null;

    // 2) SerpApi Google Maps
    const result = await serpApiGoogleMaps({ key, city, lat, lon });

    if (!result.ok) {
      return res.status(result.status).json({
        error: "SerpApi Fehler",
        details: result.data,
      });
    }

    // 3) Wichtiger Teil: Daten vereinheitlichen
    // google_maps liefert meistens "local_results"
    const localResults =
      result.data?.local_results ||
      result.data?.place_results ||
      [];

    // Antwort so, dass deine HTML sie leicht findet:
    // - json.data.local_results (Hauptweg)
    // - json.local_results (Fallback)
    return res.json({
      source: "serpapi-google_maps",
      input: q,
      resolved_city: city,
      coords_used: lat && lon ? { lat, lon } : null,

      // Fallback-Shortcut:
      local_results: localResults,

      // Standard:
      data: {
        local_results: localResults,
        raw: result.data, // wenn du debuggen willst
      },
    });
  } catch (e) {
    return res.status(500).json({
      error: "Serverfehler",
      details: String(e?.message || e),
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});