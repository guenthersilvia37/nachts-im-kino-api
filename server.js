import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * CORS: Damit deine Website (anderes Domain/Port) diese API nutzen darf.
 * Falls du später “nur deine Domain” erlauben willst, sag Bescheid.
 */
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

/**
 * Geocoding über OpenStreetMap Nominatim (Ort/PLZ -> lat/lon)
 */
async function geocode(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);

  const r = await fetch(url, {
    headers: { "User-Agent": "nachts-im-kino/1.0 (render)" },
  });

  if (!r.ok) return null;

  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
  };
}

/**
 * Showtimes: Ort/PLZ -> (geocode) -> RapidAPI International Showtimes
 *
 * Test:
 * /api/showtimes?q=Berlin
 */
app.get("/api/showtimes", async (req, res) => {
  try {
    const rapidKey = (process.env.RAPIDAPI_KEY || "").trim();
    if (!rapidKey) {
      return res
        .status(500)
        .json({ error: "RAPIDAPI_KEY fehlt (Render Environment Variables)" });
    }

    const q = (req.query.q || "").toString().trim();
    if (!q) {
      return res
        .status(400)
        .json({ error: "Parameter q fehlt (z. B. ?q=Berlin)" });
    }

    const loc = await geocode(q);
    if (!loc) {
      return res.status(404).json({ error: "Ort nicht gefunden" });
    }

    // Zeitfenster: jetzt bis +24h
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Parameter wie bisher
    const params = new URLSearchParams({
      location: `${loc.lat},${loc.lon}`,
      distance: "10",
      countries: "DE",
      time_from: now.toISOString(),
      time_to: tomorrow.toISOString(),
      append: "movies,cinemas",
    });

    // ✅ RapidAPI Endpoint (wie in RapidAPI links: showtimes → getShowtimes)
    const url =
      "https://international-showtimes.p.rapidapi.com/showtimes/getShowtimes?" +
      params.toString();

    const r = await fetch(url, {
      headers: {
        // ✅ exakt wie RapidAPI Snippets
        "x-rapidapi-key": rapidKey,
        "x-rapidapi-host": "international-showtimes.p.rapidapi.com",
        "accept-language": "de",
      },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      // Das gibt dir im Browser sauber die echte RapidAPI Fehlermeldung zurück
      return res.status(r.status).json({
        error: "RapidAPI Fehler",
        status: r.status,
        details: data,
      });
    }

    return res.json(data);
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