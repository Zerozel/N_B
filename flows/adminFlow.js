const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');

// ⚠️ HARDCODED SECURITY: Only this number can trigger admin commands
const ADMIN_NUMBER = '2347079722171'; 

async function handleAdminFlow(from, text) {
  // If the sender is not you, ignore this file completely
  if (from !== ADMIN_NUMBER) return false; 

  const upperText = text.trim().toUpperCase();
  // --- THE UNBLOCK COMMAND ---
  // Usage: Admin texts "UNBLOCK 2348012345678"
  if (upperText.startsWith('UNBLOCK ')) {
    const targetNumber = cleanText.replace('UNBLOCK ', '').replace('unblock ', '').trim();
    
    const { error } = await supabase
      .from('artisans')
      .update({ is_available: true })
      .eq('phone_number', targetNumber);

    if (error) {
      await sendMessage(from, `❌ Database error. Could not unblock +${targetNumber}.`);
    } else {
      await sendMessage(from, `🔓 Artisan +${targetNumber} is now UNBLOCKED and available to receive job broadcasts again.`);
    }
    return true;
  }

  // --- THE SECRET TRIGGER ---
  if (upperText === 'NEXA LOGS') {
    await sendMessage(from, '📊 *Generating Monthly Nexa Report...*');

    // Get the exact timestamp for the 1st day of the current month
    const date = new Date();
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1).toISOString();

    // Query the database for this month's jobs (limit to 25 to protect WhatsApp limits)
    const { data: jobs, error } = await supabase
      .from('job_tickets')
      .select('job_id, category, status, client_phone')
      .gte('created_at', firstDay)
      .order('created_at', { ascending: false })
      .limit(25); 

    if (error || !jobs || jobs.length === 0) {
      await sendMessage(from, '📂 No jobs have been recorded yet for this month.');
      return true;
    }

    // Build the text receipt
    let report = `📅 *MONTHLY DIGEST (${jobs.length} recent jobs)*\n\n`;
    
    jobs.forEach(job => {
      report += `*Job #${job.job_id}* | ${job.category}\n`;
      report += `📱 Client: +${job.client_phone}\n`;
      report += `🚥 Status: *${job.status}*\n`;
      report += `-------------------\n`;
    });

    report += `\n_(Note: Showing max 25 recent jobs to prevent message clipping. Full export will be available on the Web Dashboard)._`;

    await sendMessage(from, report);
    return true;
  }

  return false;
}

module.exports = { handleAdminFlow };
