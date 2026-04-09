require('dotenv').config();
const axios = require('axios');

// Set up the global Meta Graph API endpoint and authentication headers
const META_URL = `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`;
const HEADERS = {
  'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

/**
 * Sends a standard plain text message.
 * @param {string} toPhoneNumber - The recipient's number (e.g., '2348012345678')
 * @param {string} messageText - The body of the message.
 */
async function sendMessage(toPhoneNumber, messageText) {
  // Automatically clean old database tags (@c.us) to prevent routing errors
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: cleanNumber,
      type: 'text',
      text: { body: messageText }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ TEXT ERROR TO ${cleanNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends an interactive message with up to 3 Quick Reply buttons.
 * @param {string} toPhoneNumber - The recipient's number.
 * @param {string} bodyText - The main text of the message.
 * @param {Array} buttons - Array of objects: [{ id: 'CMD_ID', title: 'Button Text' }]
 */
async function sendButtonMessage(toPhoneNumber, bodyText, buttons) {
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  // Format the simplified buttons array into Meta's strict JSON structure
  const formattedButtons = buttons.map(btn => ({
    type: 'reply',
    reply: { id: btn.id, title: btn.title }
  }));

  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: cleanNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: formattedButtons }
      }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ BUTTON ERROR TO ${cleanNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends an interactive List Message (Dropdown menu) for 4+ options.
 * @param {string} toPhoneNumber - The recipient's number.
 * @param {string} bodyText - The main text explaining what to select.
 * @param {string} buttonLabel - The text on the button that opens the list (e.g., 'Select Zone').
 * @param {Array} sections - Array of sections containing rows (See Meta docs for structure).
 */
async function sendListMessage(toPhoneNumber, bodyText, buttonLabel, sections) {
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: cleanNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonLabel, sections: sections }
      }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ LIST ERROR TO ${cleanNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends a pre-approved Meta Template Message. Used to bypass the 24-hour restriction window.
 * @param {string} toPhoneNumber - The recipient's number.
 * @param {string} templateName - The exact name of the template approved in Meta Business Manager.
 * @param {Array} variables - Array of strings to fill the {{1}}, {{2}} placeholders.
 * @returns {boolean} - Returns true if successful, false if rejected.
 */
async function sendTemplateMessage(toPhoneNumber, templateName, variables) {
  const cleanNumber = String(toPhoneNumber).replace('@c.us', '');
  
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: cleanNumber,
      type: 'template',
      template: {
        name: templateName,
        // Forcing en_US to bypass Meta's hidden language mismatch bug
        language: { code: 'en_US' }, 
        components: [{
          type: 'body',
          // Meta strictly requires all variable parameters to be formatted as strings
          parameters: variables.map(val => ({ type: 'text', text: String(val) }))
        }]
      }
    }, { headers: HEADERS });
    
    return true;
  } catch (err) {
    // Stringify the error response to see exactly what variable Meta rejected in Render logs
    console.error(`❌ TEMPLATE ERROR TO ${cleanNumber}:`, err.response ? JSON.stringify(err.response.data) : err.message);
    return false;
  }
}

module.exports = { 
  sendMessage, 
  sendButtonMessage, 
  sendListMessage, 
  sendTemplateMessage 
};
