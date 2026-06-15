require('dotenv').config();
const axios = require('axios');

async function testAI() {
  const aiKey = process.env.AI_API_KEY;
  const aiUrl = process.env.AI_API_URL;
  const aiModel = process.env.AI_MODEL;

  console.log('Testing model:', aiModel);

  try {
    const response = await axios.post(
      aiUrl,
      {
        model: aiModel,
        max_tokens: 200,
        messages: [
          { role: 'system', content: 'You are a helpful tech educator.' },
          { role: 'user', content: 'Define this tech term: "graphql"' },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${aiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5000',
          'X-Title': 'easy-rewind Learning Assistant',
        },
      }
    );

    console.log('✅ SUCCESS!', response.data?.choices?.[0]?.message?.content?.slice(0, 100));
  } catch (error) {
    console.log('❌ ERROR FULL:', JSON.stringify(error.response?.data, null, 2));
  }
}
testAI();
