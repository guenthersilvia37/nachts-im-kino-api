import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

async function geocode(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);

  const r = await fetch(url, {
    headers: { "User-Agent": "nachts-im-kino/1.0" }
  });

  const data = await r.json();
  if (!data.length) return null;

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
  };
}

app.get("/api/showtimes", async (req, res) => {
  try {
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) {
      return res.status(500).json({ error: "RAPIDAPI_KEY fehlt in Render!" });
    }

    const q = req.query.q;
    if (!q) {
      return res.status(400).json({ error: "q fehlt" });
    }

    const loc = await geocode(q);
    if (!loc) {
      return res.status(404).json({ error: "Ort nicht gefunden" });
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      location: `${loc.lat},${loc.lon}`,
      distance: "10",
      time_from: now.toISOString(),
      time_to: tomorrow.toISOString(),
      countries: "DE"
    });

    const url =
      "https://international-showtimes.p.rapidapi.com/showtimes?" +
      params.toString();

    const r = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": rapidKey,
        "X-RapidAPI-Host": "international-showtimes.p.rapidapi.com"
      }
    });

    const data = await r.json();
    res.json(data);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});