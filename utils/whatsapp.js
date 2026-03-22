require('dotenv').config();
const axios = require('axios');

async function sendMessage(toPhoneNumber, messageText) {
  // Automatically clean old database tags (@c.us) before sending
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  const url = `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`;
  
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanNumber,
    type: 'text',
    text: { body: messageText }
  };

  try {
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    // console.log(`✅ Sent to ${cleanNumber}`);
  } catch (err) {
    console.error(`❌ META REJECTED PAYLOAD TO ${cleanNumber}:`, err.response ? err.response.data : err.message);
  }
}

module.exports = { sendMessage };
