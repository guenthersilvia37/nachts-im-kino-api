import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (damit deine Website die API nutzen darf)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

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

app.get("/api/showtimes", async (req, res) => {
  try {
    const key = (process.env.SERPAPI_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "SERPAPI_KEY fehlt" });

    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "q fehlt" });

    // 1) Ort/PLZ -> Nominatim (liefert display_name + addressdetails)
    const geo = await nominatimSearch(q);
    if (!geo.length) return res.status(404).json({ error: "Ort nicht gefunden" });

    // 2) Bestmögliche “location” für SerpApi bauen
    //    SerpApi mag eher Stadt/Ort als "10115, Deutschland"
    const a = geo[0].address || {};
    const city =
      a.city ||
      a.town ||
      a.village ||
      a.municipality ||
      a.county ||
      geo[0].display_name.split(",")[0];

    const location = `${city}, Germany`;

    // 3) SerpApi Google Search
    //    Query so, dass Google sehr oft Kino-/Showtimes-Infos zeigt
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", `Kino Spielzeiten ${city}`);
    url.searchParams.set("location", location);
    url.searchParams.set("hl", "de");
    url.searchParams.set("gl", "de");
    url.searchParams.set("google_domain", "google.de");
    url.searchParams.set("api_key", key);

    const r = await fetch(url.toString());
    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(r.status).json({
        error: "SerpApi Fehler",
        details: data,
      });
    }

    // Debug/Info: wir geben immer die Location zurück, damit du siehst, was genutzt wurde
    return res.json({
      source: "serpapi-google",
      input: q,
      resolved_city: city,
      location_used: location,
      data,
    });
  } catch (e) {
    return res.status(500).json({ error: "Serverfehler", details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});