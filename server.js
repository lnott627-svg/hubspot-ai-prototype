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

// The API Endpoint your frontend will call
app.post('/api/diagnose', async (req, res) => {
    try {
        // 1. Receive the simulated database state from your frontend
        const { activeContacts, recycleBin, attemptedUpload } = req.body;

        // 2. Select the fast, lightweight model and force JSON output
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.7-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        // 3. The System Prompt (Injecting the context behind the scenes)
        const prompt = `
        You are Breeze AI, an embedded diagnostic assistant inside the HubSpot CRM. 
        Your tone is helpful, concise, and direct. Do not greet the user.

        A user has just experienced a failed CSV import due to a quota limit. 
        Here is their current live database state:
        - Tier Limit: 1,000 contacts
        - Active Contacts: ${activeContacts}
        - Contacts in Recycle Bin: ${recycleBin}
        - Attempted Import Size: ${attemptedUpload}

        Task:
        1. Explain exactly why their import failed using the math above.
        2. Offer a solution to clear the recycle bin to make room.
        3. Return your response strictly in the following JSON format:
        {
          "dialogue": "Your explanation here...",
          "action_button": {
            "label": "Permanently Empty Bin",
            "action_id": "purge_bin"
          }
        }
        `;

        // 4. Send to Gemini and parse the response
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // 5. Send the structured JSON back to your frontend UI
        res.json(JSON.parse(text));

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: 'Failed to generate AI diagnosis.' });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});