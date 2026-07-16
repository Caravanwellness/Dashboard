export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query, mode, candidates, total } = req.body || {};
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
    // ── Curation mode: Fable picks actual items from the candidate pool ──────
    if (mode === 'curation' && candidates && candidates.length) {
      const catalogSummary = candidates
        .map(c => `${c.id}|${c.type}|${c.category}|${c.title}${c.teacher ? '|'+c.teacher : ''}${c.duration ? '|'+c.duration : ''}`)
        .join('\n');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-fable-5',
          max_tokens: 4096,
          system: `You are a wellness content curator for Caravan Wellness. You select the best content from a library to match a client's specific needs.

Each catalog line is: ID|Type|Category|Title|Teacher|Duration

Your job: read the client's brief, reason about what they actually need, and select the best items. Prioritise relevance and variety — avoid picking too many items from the same category unless specifically requested. Respect any format or topic ratios mentioned.

Return ONLY valid JSON, no other text:
{
  "selected": ["ID1", "ID2", ...],
  "reasoning": "2-3 sentence explanation of the selection strategy"
}`,
          messages: [{
            role: 'user',
            content: `Client brief: "${query}"
Requested total: ${total || 100} items

Available content (${candidates.length} pre-filtered candidates):
${catalogSummary}

Select the best ${total || 100} items from the list above. Return their IDs in order of relevance.`,
          }],
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: err });
      }

      const data = await response.json();
      const text = data.content[0].text.trim();
      const parsed = JSON.parse(text);
      return res.json(parsed);
    }

    // ── Search mode: Fable extracts intent from a natural-language query ────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 512,
        system: `You are a search assistant for Caravan Wellness's health content library.
Available categories: ${CATEGORIES.join(', ')}
Available content types: ${TYPES.join(', ')}
Extract the user's search intent and return ONLY valid JSON, no other text.`,
        messages: [{
          role: 'user',
          content: `Search query: "${query}"

Return JSON:
{
  "keywords": ["word1", "word2"],
  "categories": [],
  "types": [],
  "explanation": "One sentence describing what was searched"
}`,
        }],
      }),
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
