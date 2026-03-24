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

// --- NEW TEMPLATE FUNCTION ---
// Bypasses the 24-hour Meta window restriction
async function sendTemplateMessage(toPhoneNumber, templateName, variables) {
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  const url = `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`;
  
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanNumber,
    type: 'template',
    template: {
      name: templateName,
      // CHANGED: Forcing en_US to bypass Meta's hidden language mismatch bug
      language: { code: 'en_US' }, 
      components: [
        {
          type: 'body',
          parameters: variables.map(val => ({
            type: 'text',
            text: String(val) // Meta strictly requires all variables to be strings
          }))
        }
      ]
    }
  };

  try {
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Template '${templateName}' sent to ${cleanNumber}`);
    return true;
  } catch (err) {
    // Stringify the error response so you can see exactly what Meta didn't like in your Render logs
    console.error(`❌ META REJECTED TEMPLATE TO ${cleanNumber}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

module.exports = { sendMessage, sendTemplateMessage };
