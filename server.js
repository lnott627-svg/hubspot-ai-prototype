require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Initialize the Gemini API using your secret key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// The API endpoint the frontend's requestBreezeDiagnosis() calls. Request
// body and response shape must match buildDiagnosisPayload() / normalizeDiagnosis()
// in index.html exactly — the frontend silently falls back to a canned triage
// on anything it doesn't recognize, so a shape mismatch here fails invisibly.
app.post('/api/diagnose', async (req, res) => {
    try {
        const {
            tier, contactLimit, activeContacts, selectedForMarketing,
            prospectiveTotal, overageCost, origin, availableActions
        } = req.body;

        const model = genAI.getGenerativeModel({
            model: MODEL_NAME,
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        You are Breeze AI, an embedded diagnostic assistant inside the HubSpot CRM.
        Your tone is helpful, concise, and direct. Do not greet the user.

        A user on the ${tier} is about to cross their marketing-contact limit.
        - Marketing contact limit: ${contactLimit}
        - Current marketing contacts: ${activeContacts}
        - Contacts they're about to set as marketing: ${selectedForMarketing}
        - Resulting total if applied: ${prospectiveTotal}
        - Monthly cost of breaching the limit: ${overageCost}
        - Context: ${origin === 'pre-emptive' ? 'they have not yet been charged an overage' : 'they have already been charged an overage and are trying to get back under the limit'}

        Here is the canonical catalogue of cleanup actions they can take. You may
        only recommend actions from this exact list, by their action_id — never
        invent a new one:
        ${JSON.stringify(availableActions, null, 2)}

        Task:
        1. Write one short sentence diagnosing the situation using the numbers above.
        2. Choose which of the catalogue actions to recommend (as many as make sense
           to get them back under or keep them under the limit), and write one short
           sentence of reasoning for each ("why this one").
        3. Return your response strictly in the following JSON format, with no
           extra commentary:
        {
          "dialogue": "Your one-sentence diagnosis here...",
          "chips": [
            { "action_id": "one_of_the_ids_above", "reason": "One short sentence." }
          ]
        }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        res.json(JSON.parse(text));

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: 'Failed to generate AI diagnosis.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
