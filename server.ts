import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { registerBoundaryRoutes } from './server/boundaryRoutes';
import { registerWeatherRoutes } from './server/weatherRoutes';
import { registerPushRoutes } from './server/pushRoutes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', app: 'Wandrlust' });
  });

  // Public land boundaries (3 authoritative gov ArcGIS services)
  registerBoundaryRoutes(app);

  // Weather + fire / flood / storm alerts (NWS + Environment Canada)
  registerWeatherRoutes(app);

  // Web Push delivery
  registerPushRoutes(app);

  // AI-Powered Camping Assistant & Location Spot Discoverer
  app.post('/api/camping-ai', async (req, res) => {
    const { locationName, lat, lon } = req.body;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(200).json({
        spots: [],
        message: 'No Gemini API key provided. Using built-in BLM and National Forest dataset.'
      });
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
      const prompt = `You are an expert public lands, BLM (Bureau of Land Management), and US Forest Service dispersed camping advisor.
Location target: "${locationName}" (Coordinates: ${lat}, ${lon}).

Generate 2 authentic, high-quality FREE public land (BLM or USFS) dispersed camping options near this location if any exist.
Return ONLY a valid JSON array of objects with the following schema:
[
  {
    "id": "ai-discovered-1",
    "name": "Campsite Name",
    "landType": "blm" | "usfs" | "state_forest" | "dispersed",
    "landManager": "Manager agency name",
    "latitude": number,
    "longitude": number,
    "elevationFt": number,
    "address": {
      "nearestCity": "${locationName}",
      "stateProvince": "",
      "country": ""
    },
    "description": "Short vivid description of location, road conditions, and views",
    "amenities": {
      "water": "none" | "potable" | "natural_stream",
      "toilet": "none" | "vault" | "pack_out",
      "roadAccess": "paved" | "gravel" | "high_clearance" | "4x4_only",
      "cellSignal": { "verizon": 3, "att": 3, "tmobile": 2 },
      "maxRvLengthFeet": 30,
      "fireRing": true,
      "petFriendly": true,
      "trashService": false,
      "shade": "partial",
      "stayLimitDays": 14,
      "isFree": true,
      "permitRequired": false
    },
    "images": ["https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?auto=format&fit=crop&w=1000&q=80"],
    "rating": 4.8,
    "reviewCount": 15
  }
]
Do not output markdown codeblocks, only valid JSON.`;

      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
        contents: prompt
      });

      const text = response.text || '';
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);

      res.json({ spots: parsed, message: 'AI Discovered Public Land Spots' });
    } catch (err: any) {
      console.error('Gemini API Error:', err.message);
      res.status(200).json({ spots: [], error: err.message });
    }
  });

  // Vite middleware for dev or static server for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA fallback. Must also serve /auth/callback so the OAuth redirect
    // reaches the client and the PKCE exchange can complete.
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Wandrlust server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();


