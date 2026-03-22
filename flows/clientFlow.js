const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');
const { extractNumber, detectCategoryIntent } = require('../utils/fuzzyRouter');

const CUSTOMER_SERVICE_NUMBER = '2349032925721'; // Live routing for manual escalation

async function handleClientFlow(user, from, text) {
  const cleanText = text.trim();
  const lowerText = cleanText.toLowerCase();

  // --- GLOBAL ESCAPE HATCH ---
  if (lowerText === 'menu' || lowerText === 'cancel' || lowerText === 'restart') {
    await supabase.from('users').update({ status: 'AWAITING_INTAKE_TYPE' }).eq('phone_number', from);
    await sendMessage(from, '🔄 *Main Menu* 🛠️\n\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
    return true; // Return true tells the main router this message was handled
  }

  // --- PHASE H: THE INTAKE FUNNEL ---
  if (user.status === 'NEW' || user.status === 'IDLE') {
    // 1. Check for fuzzy intent first (Fast-Track Bypass)
    const intentCategory = detectCategoryIntent(cleanText);
    if (intentCategory) {
      await supabase.from('users').update({ status: `AWAITING_LOCATION_${intentCategory}` }).eq('phone_number', from);
      await sendMessage(from, `✅ We noticed you need a *${intentCategory}* service. Let's get that sorted.\n\nPlease reply with your exact location/address (e.g., Block A, Campus Hostel).`);
      return true;
    }

    // 2. Normal flow
    await supabase.from('users').update({ status: 'AWAITING_INTAKE_TYPE' }).eq('phone_number', from);
    await sendMessage(from, 'Welcome to *Nexa*! 🛠️\n\nAre you looking for a service or just asking a question?\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
    return true;
  }

  if (user.status === 'AWAITING_INTAKE_TYPE') {
    const choice = extractNumber(cleanText, ['1', '2']); // Forgives typos
    
    if (choice === '1') {
      await supabase.from('users').update({ status: 'AWAITING_CATEGORY' }).eq('phone_number', from);
      await sendMessage(from, 'Great. What type of artisan do you need right now?\n\n1️⃣ Electrical\n2️⃣ Plumbing\n3️⃣ Carpentry');
    } else if (choice === '2') {
      await supabase.from('users').update({ status: 'ENQUIRY_MODE' }).eq('phone_number', from);
      await sendMessage(from, 'Please type your enquiry below. A Nexa agent will review it shortly. (Reply "menu" at any time to go back).\n\n*Direct Customer Service: 09045955670*');
    } else {
      await sendMessage(from, 'Welcome back to *Nexa*! 🛠️\n\nAre you looking for a service or just asking a question?\nReply with a number:\n1️⃣ Service Call\n2️⃣ Make an Enquiry');
    }
    return true;
  }

  if (user.status === 'AWAITING_CATEGORY') {
    // Check if they typed the category directly instead of a number
    let category = detectCategoryIntent(cleanText);
    
    // If not, check if they typed a valid number
    if (!category) {
      const choice = extractNumber(cleanText, ['1', '2', '3']);
      const map = { '1': 'Electrical', '2': 'Plumbing', '3': 'Carpentry' };
      category = map[choice];
    }

    if (category) {
      await supabase.from('users').update({ status: `AWAITING_LOCATION_${category}` }).eq('phone_number', from);
      await sendMessage(from, `✅ We have registered a *${category}* request.\n\nPlease reply with your exact location/address (e.g., Block A, Campus Hostel).`);
    } else {
      await sendMessage(from, '❌ I didn\'t quite catch that. Please reply with *1*, *2*, or *3*, or just type the service you need.');
    }
    return true;
  }

  if (user.status.startsWith('AWAITING_LOCATION_')) {
    const category = user.status.split('_')[2];
    await supabase.from('users').update({ status: `AWAITING_DESC_${category}_${cleanText}` }).eq('phone_number', from);
    await sendMessage(from, `📍 Location saved.\n\nFinally, please briefly describe the *${category}* issue (e.g., "Sparking wall socket" or "Broken pipe").`);
    return true;
  }

  if (user.status.startsWith('AWAITING_DESC_')) {
    const parts = user.status.split('_');
    const category = parts[2];
    const location = parts.slice(3).join('_'); 
    const description = cleanText;
    
    const { data: job, error: jobError } = await supabase.from('job_tickets').insert([{
      client_phone: from,
      category: category,
      location: location,
      description: description,
      status: 'SEARCHING'
    }]).select().single();
    
    if (jobError) throw jobError;
    
    await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
    await sendMessage(from, '⚙️ *Request received!* Processing your ticket...\nSearching for available artisans nearby. We will notify you once a match is found.');
    
    console.log(`🚨 INITIATING BROADCAST FOR JOB #${job.job_id} | Category: ${category}`);
    
    const { data: artisans } = await supabase.from('artisans').select('*').eq('category', category).eq('is_available', true).limit(3);
    
    if (!artisans || artisans.length === 0) {
      await supabase.from('job_tickets').update({ status: 'FAILED_NO_ARTISANS' }).eq('job_id', job.job_id);
      await sendMessage(from, '⚠️ We are sorry, but there are no available artisans in that category right now. Please try again later.\n\n💬 *For further assistance, chat with Nexa Customer Service: 09045955670*');
      return true;
    }
    
    const artisanNumbers = artisans.map(a => a.phone_number);
    await supabase.from('job_tickets').update({ status: 'BROADCASTED', notified_artisans: artisanNumbers }).eq('job_id', job.job_id);
    
    for (const phone of artisanNumbers) {
      await sendMessage(phone, `🚨 *FAST MATCH ALERT!* 🚨\n\n*Job ID:* #${job.job_id}\n*Category:* ${category}\n*Location:* ${location}\n*Issue:* ${description}\n\n*(First to accept gets the client)*\nReply *ACCEPT ${job.job_id}* to claim this job.`);
    }
    return true;
  }

  // --- ENQUIRY MODE LOOP ---
  if (user.status === 'ENQUIRY_MODE') {
    await supabase.from('users').update({ status: 'WAITING_FOR_MATCH' }).eq('phone_number', from);
    await sendMessage(CUSTOMER_SERVICE_NUMBER, `🚨 *NEW NEXA ENQUIRY*\n\n*From:* +${from}\n*Message:* "${cleanText}"\n\n_Reply directly to their number to assist them._`);
    await sendMessage(from, '✅ *Your enquiry has been received!*\n\nA human agent will review this shortly. For immediate assistance, please chat directly with Nexa Customer Service at: *09045955670*\n\n(Reply "menu" anytime to start a new request).');
    return true;
  }
  
  if (user.status === 'WAITING_FOR_MATCH') {
    await sendMessage(from, '⏳ We are currently contacting available artisans in your area. Please stand by!\n\n(Reply "menu" at any time to cancel this search and start over).');
    return true;
  }

  return false; // Tells the router this state belongs to someone else (like the Artisan)
}

module.exports = { handleClientFlow };
