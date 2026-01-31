import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS erlauben (deine Website darf die API aufrufen)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

async function geocode(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query);

  const r = await fetch(url, {
    headers: { "User-Agent": "nachts-im-kino/1.0 (render)" }
  });

  const data = await r.json();
  if (!data?.length) return null;

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
  };
}

app.get("/api/showtimes", async (req, res) => {
  try {
    const rapidKey = process.env.RAPIDAPI_KEY;
    if (!rapidKey) return res.status(500).json({ error: "RAPIDAPI_KEY fehlt (Render Env Vars)" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Parameter q fehlt (z. B. ?q=Berlin)" });

    const loc = await geocode(q);
    if (!loc) return res.status(404).json({ error: "Ort nicht gefunden" });

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const isKey = process.env.IS_API_KEY || process.env.RAPIDAPI_KEY;

const now = new Date();
const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

const params = new URLSearchParams({
  location: `${loc.lat},${loc.lon}`,
  distance: "10",
  countries: "DE",
  time_from: now.toISOString(),
  time_to: tomorrow.toISOString(),
  append: "movies,cinemas",
  apikey: isKey
});

const url =
  "https://international-showtimes.p.rapidapi.com/showtimes/getShowtimes?" +
  params.toString();

const r = await fetch(url, {
  headers: {
    "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
    "X-RapidAPI-Host": "international-showtimes.p.rapidapi.com",
    "X-API-Key": isKey,
    "X-Api-Key": isKey,
    "Accept-Language": "de"
  }
});
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "RapidAPI Fehler", details: data });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft");
});
