require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ---------------------------------------------------------------------------
   CONFIG
   The model id and timeout live here so the whole backend is tunable from
   one place. GEMINI_MODEL / GEMINI_TIMEOUT_MS can override via .env.
--------------------------------------------------------------------------- */
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const AI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 2200;

// Only construct the client if a key is actually present. If it isn't, every
// /api/diagnose call returns 503 and the frontend silently falls back to its
// canned triage — the demo still works with no key at all.
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

/* ---------------------------------------------------------------------------
   Health check — handy for confirming the server is up and whether a key is
   configured, without exposing the key itself.
--------------------------------------------------------------------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL_NAME, keyConfigured: Boolean(apiKey) });
});

/* ---------------------------------------------------------------------------
   Prompt builder
   Feeds Gemini the live account state and the CANONICAL list of remediation
   actions the frontend is willing to run. The model's job is only to (a)
   write the diagnosis and (b) choose which of these actions to surface — it
   is explicitly told not to invent action_ids or change any numbers. The
   frontend re-maps whatever comes back onto its own catalogue by action_id,
   so even a misbehaving model can't corrupt the on-screen math.
--------------------------------------------------------------------------- */
function buildPrompt(payload) {
  const {
    tier,
    contactLimit,
    activeContacts,
    selectedForMarketing,
    prospectiveTotal,
    overageCost,
    origin,
    availableActions
  } = payload;

  const actionsBlock = (availableActions || [])
    .map(a => `  - action_id "${a.action_id}" (${a.type}): "${a.label}" — ${a.detail} — frees ${a.count} contacts`)
    .join('\n');

  const situation = origin === 'breach-recovery'
    ? `The user has ALREADY crossed their limit and a ${overageCost}/month upgrade is pending. They want to free up capacity to cancel it.`
    : `The user is about to set ${selectedForMarketing} contacts as marketing, which would push them to ${prospectiveTotal} — over their ${contactLimit} limit — triggering a ${overageCost}/month upgrade tonight.`;

  return `
You are Breeze AI, an embedded diagnostic assistant inside the HubSpot CRM.
Your tone is helpful, concise, calm, and direct. Do not greet the user. Do not
use their name. Write in the first person ("I found…", "I can…"). One to two
short sentences maximum.

SITUATION
- Pricing tier: ${tier}
- Marketing-contact limit: ${contactLimit}
- Current marketing contacts: ${activeContacts}
- ${situation}

REMEDIATION ACTIONS YOU MAY OFFER (choose from these EXACTLY — do not invent
new ones, do not change the counts):
${actionsBlock}

TASK
1. Write a brief "dialogue" that diagnoses why they're at risk, using the real
   numbers above, and tells them you can clean up low-value records to fix it.
2. Choose which of the actions above to surface as chips. Prefer the smallest
   set of actions that, added together, frees enough capacity to keep them
   under the ${contactLimit} limit. If in doubt, offer all of them.
3. For EACH chip, write a one-sentence "reason" (under 140 characters) that
   explains specifically why THAT action helps — cite real numbers, e.g. how
   many contacts it frees and what that brings the running total to. Do not
   repeat the dialogue verbatim; each reason should be specific to its own
   action.
4. Return your answer STRICTLY as JSON in exactly this shape, nothing else:
{
  "dialogue": "Your one-to-two sentence diagnosis here.",
  "chips": [
    { "action_id": "one_of_the_ids_above", "label": "short button label", "reason": "Why this specific action helps, with real numbers." }
  ]
}

Use only action_id values from the list above. Do not include any action_id
that is not listed. Do not add commentary outside the JSON.`;
}

/* ---------------------------------------------------------------------------
   Validation
   Never trust model output. Confirm we got a usable dialogue and at least one
   chip whose action_id is in the canonical set we sent. Anything else → null,
   which the endpoint turns into a 502 so the frontend falls back.
--------------------------------------------------------------------------- */
function validateDiagnosis(parsed, availableActions) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.dialogue !== 'string' || !parsed.dialogue.trim()) return null;
  if (!Array.isArray(parsed.chips)) return null;

  const allowed = new Set((availableActions || []).map(a => a.action_id));
  const seen = new Set();
  const chips = [];
  for (const chip of parsed.chips) {
    const id = chip && chip.action_id;
    if (allowed.has(id) && !seen.has(id)) {
      seen.add(id);
      chips.push({
        action_id: id,
        label: typeof chip.label === 'string' && chip.label.trim() ? chip.label.trim() : id,
        // Capped hard — this is display copy, not something a slow/verbose
        // model response should be able to bloat the payload with.
        reason: typeof chip.reason === 'string' ? chip.reason.trim().slice(0, 220) : ''
      });
    }
  }
  if (chips.length === 0) return null;

  return { dialogue: parsed.dialogue.trim(), chips };
}

// Wraps a promise in a timeout so a slow model can never hang the request.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), ms))
  ]);
}

/* ---------------------------------------------------------------------------
   The diagnosis endpoint
--------------------------------------------------------------------------- */
app.post('/api/diagnose', async (req, res) => {
  const payload = req.body || {};

  // No key → tell the frontend to fall back. (503 = service unavailable.)
  if (!genAI) {
    return res.status(503).json({ error: 'AI unavailable: no API key configured.' });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await withTimeout(
      model.generateContent(buildPrompt(payload)),
      AI_TIMEOUT_MS
    );

    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('AI returned non-JSON:', text);
      return res.status(502).json({ error: 'AI returned malformed output.' });
    }

    const clean = validateDiagnosis(parsed, payload.availableActions);
    if (!clean) {
      console.error('AI output failed validation:', parsed);
      return res.status(502).json({ error: 'AI output failed validation.' });
    }

    res.json(clean);
  } catch (error) {
    // Timeout, network, quota, bad key — all land here. The frontend treats
    // any non-200 as "fall back", so the demo never breaks in front of a client.
    console.error('AI Error:', error.message || error);
    res.status(502).json({ error: 'Failed to generate AI diagnosis.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL_NAME}`);
  console.log(`  Gemini key configured: ${Boolean(apiKey)}`);
});
