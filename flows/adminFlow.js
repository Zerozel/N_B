// flows/adminFlow.js
const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '2347079722171';

async function handleAdminFlow(profile, payload) {
  const from = profile.phone_number;

  // Security gate
  if (from !== ADMIN_NUMBER) return false;

  const command = payload.toUpperCase();

  // --- UNBLOCK COMMAND ---
  // Usage: UNBLOCK 23480XXXXXXXX
  if (command.startsWith('UNBLOCK ')) {
    const targetNumber = command.replace('UNBLOCK ', '').trim();

    const { error } = await supabase
      .from('artisan_meta')
      .update({ is_available: true })
      .eq('phone_number', targetNumber);

    if (error) {
      await sendMessage(from, `❌ Error: Could not unblock +${targetNumber}. Is the number registered?`);
    } else {
      // Also reset their profile status in case they're stuck
      await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', targetNumber);
      await sendMessage(from, `🔓 +${targetNumber} is now UNBLOCKED and available for job matching.`);
    }
    return true;
  }

  // --- MONTHLY REPORT ---
  // Usage: NEXA LOGS
  if (command === 'NEXA LOGS') {
    await sendMessage(from, '📊 *Compiling System Report...*');

    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data: jobs } = await supabase
      .from('jobs')
      .select('status')
      .gte('created_at', firstDay);

    let completed = 0, disputed = 0, active = 0;
    jobs?.forEach(job => {
      if (job.status === 'COMPLETED') completed++;
      else if (job.status === 'DISPUTED') disputed++;
      else if (job.status.startsWith('SEARCHING_') || ['ON_SITE', 'PENDING_ON_SITE', 'CLIENT_REVIEW', 'VERIFYING_PRICE'].includes(job.status)) active++;
    });

    const { data: ledger } = await supabase
      .from('ledger')
      .select('commission_owed, payment_status')
      .gte('created_at', firstDay);

    let expectedRevenue = 0, clearedRevenue = 0;
    ledger?.forEach(e => {
      expectedRevenue += parseFloat(e.commission_owed || 0);
      if (e.payment_status === 'CLEARED') clearedRevenue += parseFloat(e.commission_owed || 0);
    });

    const monthName = now.toLocaleString('default', { month: 'long' });
    let report = `📅 *NEXA MONTHLY DIGEST — ${monthName.toUpperCase()}*\n\n`;
    report += `📈 *Job Metrics*\n`;
    report += `✅ Completed: ${completed}\n`;
    report += `⏳ Active/Searching: ${active}\n`;
    report += `⚠️ Disputed: ${disputed}\n\n`;
    report += `💰 *Revenue (15% Platform Cut)*\n`;
    report += `Expected: ₦${expectedRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`;
    report += `Cleared: ₦${clearedRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`;
    report += `Outstanding: ₦${(expectedRevenue - clearedRevenue).toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\n`;
    report += `_Full artisan breakdown: Supabase → ledger table_`;

    await sendMessage(from, report);
    return true;
  }

  return false;
}

module.exports = { handleAdminFlow };
