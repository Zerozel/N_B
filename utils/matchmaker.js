const supabase = require('../config/supabase');
// V2 TEMPLATE UPGRADE: Import sendTemplateMessage
const { sendTemplateMessage, sendMessage } = require('./whatsapp');

/**
 * Calculates the Match Score (S) for an artisan to determine ranking.
 * Formula: S = (T * 0.4) + (R * 0.3) + (C * 0.3)
 * @param {Object} artisan - The artisan object from the database.
 * @returns {number} The calculated score.
 */
function calculateMatchScore(artisan) {
  // T: Convert Tier (1, 2, 3) to a 100-point scale (Tier 1 = 100, 2 = 70, 3 = 40)
  const T = artisan.tier === 1 ? 100 : artisan.tier === 2 ? 70 : 40;
  
  // R: Convert 5.0 Trust Score to a 100-point scale
  const R = (artisan.trust_score / 5.0) * 100;
  
  // C: Completion/Activity (Mocking at 100 for now; can query the ledger later)
  const C = 100; 

  // The Algorithm
  return (T * 0.4) + (R * 0.3) + (C * 0.3);
}

/**
 * The Tiered Waterfall Dispatch Engine.
 * @param {string} jobId - The UUID of the job to match.
 */
async function triggerMatchmaker(jobId) {
  // 1. Fetch the Job Details
  const { data: job } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
  
  // Failsafe: Ensure job exists and is actively searching
  if (!job || !job.status.startsWith('SEARCHING_T')) return;

  // Extract the specific tier we are currently targeting (e.g., 'SEARCHING_T2' -> 2)
  const currentTier = parseInt(job.status.split('_T')[1]) || 1;

  // 2. Fetch Available Artisans in that exact Category
  const { data: artisans } = await supabase
    .from('artisan_meta')
    .select('artisan_id, phone_number, tier, trust_score')
    .eq('category', job.category)
    .eq('is_available', true);

  if (!artisans || artisans.length === 0) {
    return await handleNoArtisans(job);
  }

  // 3. Cross-reference with the profiles table to ensure they are strictly local to the Zone
  const { data: localProfiles } = await supabase
    .from('profiles')
    .select('phone_number')
    .eq('zone', job.zone)
    .in('phone_number', artisans.map(a => a.phone_number));

  const localPhones = localProfiles.map(p => p.phone_number);
  let localArtisans = artisans.filter(a => localPhones.includes(a.phone_number));

  // 4. Isolate the Target Group for the CURRENT Tier
  let targetGroup = localArtisans.filter(a => a.tier === currentTier);

  // 5. THE FAST-FORWARD UPGRADE
  if (targetGroup.length === 0) {
    if (currentTier < 3) {
      console.log(`⏩ Tier ${currentTier} is empty for Job #${jobId}. Fast-forwarding to Tier ${currentTier + 1}.`);
      
      await supabase.from('jobs').update({ 
        status: `SEARCHING_T${currentTier + 1}`, 
        updated_at: new Date().toISOString() 
      }).eq('job_id', jobId);
      
      return triggerMatchmaker(jobId); // Recursive call to instantly ping the next tier
    } else {
      // If Tier 3 is empty, the waterfall has run dry.
      return await handleNoArtisans(job);
    }
  }

  // 6. Score and Sort the Target Group
  targetGroup = targetGroup.map(a => ({
    ...a,
    score: calculateMatchScore(a)
  })).sort((a, b) => b.score - a.score).slice(0, 3); // Slice limits the blast to the top 3 max to prevent spam

  // 7. Blast the Target Group with Meta Templates (Bypasses 24h limit)
  for (const artisan of targetGroup) {
    await sendTemplateMessage(
      artisan.phone_number,
      'nexa_job_alert', // Your exact Meta Template Name
      [job.zone, job.problem_description] // Populates {{1}} and {{2}} in the template
    );
  }
}

/**
 * Helper function to gracefully handle a dry waterfall.
 */
async function handleNoArtisans(job) {
  console.log(`❌ Waterfall dry for Job #${job.job_id}. FAILED.`);
  await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', job.job_id);
  await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);
  await sendMessage(job.client_phone, '⚠️ We are sorry, but all our verified artisans are currently busy or unavailable in your zone. Please tap "Menu" to try again later.');
}

module.exports = { triggerMatchmaker };
