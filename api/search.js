export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Query required' });

  const CATEGORIES = [
    "Alcohol Use","Anxiety & Depression","Arthritis","Asthma","Back Pain",
    "Brain & Neurological","Cancer","COPD","Environmental Health","Financial Wellness",
    "General Heart Health","Health Screenings","Heart Disease","High Cholesterol",
    "Medications","Nutrition","Older Adults","Physical Health & Exercise",
    "Surgery & Recovery","Vaccinations","Vaping & Tobacco","Sleep","Diabetes",
    "Weight Management","Men's Health","Women's Health","Workplace Wellness","General"
  ];
  const TYPES = ["Article","Infographic","Video","Video Library","Infographic Library","Article Library"];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are a search assistant for Caravan Wellness's health content library.

Available categories: ${CATEGORIES.join(', ')}
Available content types: ${TYPES.join(', ')}

User search query: "${query}"

Extract search parameters. Return ONLY valid JSON, no other text:
{
  "keywords": ["word1", "word2"],
  "categories": [],
  "types": [],
  "explanation": "Brief one-sentence description of what was searched"
}`
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
