// utils/whatsapp.js
const axios = require('axios');

const META_URL = `https://graph.facebook.com/v20.0/${process.env.META_PHONE_ID}/messages`;
const HEADERS = {
  'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};

function clean(number) {
  return String(number).replace('@c.us', '').trim();
}

/**
 * Sends a plain text message.
 */
async function sendMessage(toPhoneNumber, messageText) {
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: clean(toPhoneNumber),
      type: 'text',
      text: { body: messageText }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ sendMessage to ${toPhoneNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends an interactive message with up to 3 Quick Reply buttons.
 * @param {Array} buttons - [{ id: 'CMD_ID', title: 'Button Text' }]
 */
async function sendButtonMessage(toPhoneNumber, bodyText, buttons) {
  // Meta enforces: max 3 buttons, title max 20 chars, id max 256 chars
  const formattedButtons = buttons.slice(0, 3).map(btn => ({
    type: 'reply',
    reply: {
      id: String(btn.id).substring(0, 256),
      title: String(btn.title).substring(0, 20)
    }
  }));

  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: clean(toPhoneNumber),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: { buttons: formattedButtons }
      }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ sendButtonMessage to ${toPhoneNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends an interactive List Message (dropdown) for 4+ options.
 * @param {Array} sections - Meta sections array with rows
 */
async function sendListMessage(toPhoneNumber, bodyText, buttonLabel, sections) {
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: clean(toPhoneNumber),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: String(buttonLabel).substring(0, 20),
          sections: sections
        }
      }
    }, { headers: HEADERS });
  } catch (err) {
    console.error(`❌ sendListMessage to ${toPhoneNumber}:`, err.response?.data || err.message);
  }
}

/**
 * Sends a pre-approved Meta Template Message (bypasses the 24-hour window).
 * @param {string} templateName - Exact name from Meta Business Manager
 * @param {Array} variables - Strings to fill {{1}}, {{2}} placeholders
 */
async function sendTemplateMessage(toPhoneNumber, templateName, variables) {
  try {
    await axios.post(META_URL, {
      messaging_product: 'whatsapp',
      to: clean(toPhoneNumber),
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en_US' },
        components: [{
          type: 'body',
          parameters: variables.map(val => ({ type: 'text', text: String(val) }))
        }]
      }
    }, { headers: HEADERS });
    return true;
  } catch (err) {
    console.error(`❌ sendTemplateMessage "${templateName}" to ${toPhoneNumber}:`, JSON.stringify(err.response?.data || err.message));
    return false;
  }
}

module.exports = { sendMessage, sendButtonMessage, sendListMessage, sendTemplateMessage };
