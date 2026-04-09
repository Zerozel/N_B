const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');

/**
 * THE COMMAND CENTER: Specialized flow for the platform owner to manage 
 * artisans and view high-level financial performance.
 */
// Fallback to your hardcoded number if ENV is not set
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '2347079722171'; 

async function handleAdminFlow(profile, payload) {
  const from = profile.phone_number;

  // Security Gate: Ensure only the authorized admin number can execute these commands
  if (from !== ADMIN_NUMBER) return false; 

  const command = payload.toUpperCase();

  // --- 1. THE UNBLOCK COMMAND ---
  // Usage: Admin sends "UNBLOCK 23480XXXXXXXX"
  if (command.startsWith('UNBLOCK ')) {
    const targetNumber = command.replace('UNBLOCK ', '').trim();
    
    // Reset artisan availability in the meta-data table
    const { error } = await supabase
      .from('artisan_meta')
      .update({ is_available: true })
      .eq('phone_number', targetNumber);

    if (error) {
      await sendMessage(from, `❌ Error: Could not update +${targetNumber}. Check if number is registered.`);
    } else {
      await sendMessage(from, `🔓 Artisan +${targetNumber} is now UNBLOCKED and available for job matching.`);
    }
    return true;
  }

  // --- 2. V2 PERFORMANCE & FINANCIAL REPORT ---
  // Usage: Admin sends "NEXA LOGS"
  if (command === 'NEXA LOGS') {
    await sendMessage(from, '📊 *Compiling V2 System Report...*');

    // Get the first day of the current month for filtering
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // A. Fetch Job Metrics
    const { data: jobs } = await supabase
      .from('jobs')
      .select('status')
      .gte('created_at', firstDay);
    
    let completed = 0;
    let disputed = 0;
    let active = 0;

    jobs?.forEach(job => {
      if (job.status === 'COMPLETED') completed++;
      else if (job.status === 'DISPUTED') disputed++;
      // Active includes anything currently in the waterfall or on-site
      else if (job.status.startsWith('SEARCHING_') || job.status === 'ON_SITE' || job.status === 'PENDING_ON_SITE') {
        active++;
      }
    });

    // B. Fetch Ledger Metrics (Revenue Tracking)
    const { data: ledger } = await supabase
      .from('ledger')
      .select('commission_owed, payment_status')
      .gte('created_at', firstDay);
    
    let expectedRevenue = 0;
    let clearedRevenue = 0;

    ledger?.forEach(entry => {
      expectedRevenue += parseFloat(entry.commission_owed || 0);
      if (entry.payment_status === 'CLEARED') {
        clearedRevenue += parseFloat(entry.commission_owed || 0);
      }
    });

    // C. Format and Send the Report
    let report = `📅 *NEXA V2 MONTHLY DIGEST*\n`;
    report += `_(Data since ${now.toLocaleString('default', { month: 'long' })} 1st)_\n\n`;
    
    report += `📈 *Job Metrics*\n`;
    report += `- ✅ Completed: ${completed}\n`;
    report += `- ⏳ Active/Searching: ${active}\n`;
    report += `- ⚠️ Disputed: ${disputed}\n\n`;
    
    report += `💰 *Revenue (15% Platform Cut)*\n`;
    report += `- Expected: ₦${expectedRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`;
    report += `- Cleared: ₦${clearedRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`;
    report += `- Outstanding: ₦${(expectedRevenue - clearedRevenue).toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\n`;
    
    report += `_Note: Detailed artisan-by-artisan breakdown is available on the Supabase Ledger table._`;

    await sendMessage(from, report);
    return true;
  }

  return false;
}

module.exports = { handleAdminFlow };
