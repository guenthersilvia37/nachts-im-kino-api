import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (Website darf API anfragen)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

/**
 * SerpApi Google Search:
 * https://serpapi.com/search-api  (engine=google)
 */
async function serpGoogleSearch({ q, location }) {
  const apiKey = (process.env.SERPAPI_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("SERPAPI_KEY fehlt (Render Environment Variables)");
    err.status = 500;
    throw err;
  }

  const params = new URLSearchParams({
    engine: "google",
    q,
    hl: "de",
    gl: "de",
    google_domain: "google.de",
    api_key: apiKey
  });

  // location ist optional, hilft aber oft für lokale Ergebnisse
  // SerpApi Location-Parameter: https://serpapi.com/blog/location/
  if (location) params.set("location", location);

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const r = await fetch(url);

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error("SerpApi Fehler");
    e.status = r.status;
    e.details = data;
    throw e;
  }

  return data;
}

/**
 * API: /api/showtimes?q=10115  oder /api/showtimes?q=Berlin
 * Gibt showtimes_results wenn vorhanden, sonst debug + organics.
 */
app.get("/api/showtimes", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Parameter q fehlt (PLZ oder Stadt)" });

    // Query so formulieren, dass Google sehr oft den Showtimes-Block zeigt
    // (kann je nach Ort schwanken)
    const query = `kino spielzeiten ${q}`;

    const result = await serpGoogleSearch({ q: query, location: `${q}, Deutschland` });

    // SerpApi liefert “rich results” je nach SERP. Für Showtimes ist oft
    // ein Block wie showtimes_results / showtimes_results_by_theater o.ä. vorhanden.
    // Wir geben das zurück, wenn es existiert – sonst Debug-Infos.
    const showtimes =
      result.showtimes_results ||
      result.showtimes ||
      result.movies_showtimes ||
      null;

    if (showtimes) {
      return res.json({
        source: "serpapi-google",
        query,
        location_hint: `${q}, Deutschland`,
        showtimes
      });
    }

    // Fallback: gib nützliche Teile zurück, damit deine Seite nie “leer” bleibt
    return res.json({
      source: "serpapi-google",
      query,
      location_hint: `${q}, Deutschland`,
      notice:
        "Kein Showtimes-Block gefunden (Google zeigt ihn nicht immer). Ich sende Debug + Top-Ergebnisse zurück.",
      top_results: (result.organic_results || []).slice(0, 5),
      knowledge_graph: result.knowledge_graph || null,
      raw_keys: Object.keys(result || {})
    });
  } catch (e) {
    return res.status(e.status || 500).json({
      error: e.message || "Serverfehler",
      details: e.details || String(e?.stack || e)
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});