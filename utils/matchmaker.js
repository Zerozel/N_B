// utils/matchmaker.js
const supabase = require('../config/supabase');
const { sendTemplateMessage, sendMessage } = require('./whatsapp');

const CS_NUMBER = process.env.CUSTOMER_SERVICE_NUMBER || '2347079722171';

/**
 * Calculates match score: S = (T*0.4) + (R*0.3) + (C*0.3)
 * T = Tier score, R = Trust score, C = Completion bonus (future use)
 */
function calculateMatchScore(artisan) {
  const T = artisan.tier === 1 ? 100 : artisan.tier === 2 ? 70 : 40;
  const R = (artisan.trust_score / 5.0) * 100;
  const C = 100;
  return (T * 0.4) + (R * 0.3) + (C * 0.3);
}

/**
 * Tiered Waterfall Dispatch Engine.
 * @param {string} jobId - UUID of the job to match.
 */
async function triggerMatchmaker(jobId) {
  const { data: job, error } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();

  if (error || !job) {
    console.error(`❌ Matchmaker: Cannot find job ${jobId}`, error);
    return;
  }

  if (!job.status.startsWith('SEARCHING_')) {
    console.log(`ℹ️  Job #${jobId} status is "${job.status}" — not searching. Skipping.`);
    return;
  }

  // --- REFERRAL BYPASS (Deep Link: NX-XXX-XXXX) ---
  const isDirectReferral = job.referred_artisan && job.referred_artisan.startsWith('NX-');

  if (job.status === 'SEARCHING_T1' && isDirectReferral) {
    console.log(`🔗 Priority Routing: Job #${jobId} → Artisan ${job.referred_artisan}`);

    const { data: preferredArtisan } = await supabase
      .from('artisan_meta')
      .select('*')
      .eq('artisan_id', job.referred_artisan)
      .eq('is_available', true)
      .single();

    if (preferredArtisan) {
      await supabase.from('jobs').update({ status: 'SEARCHING_REFERRED' }).eq('job_id', jobId);
      await sendTemplateMessage(preferredArtisan.phone_number, 'nexa_job_alert', [job.zone, job.problem_description]);

      // 10-minute window for referred artisan to respond
      setTimeout(async () => {
        const { data: checkJob } = await supabase.from('jobs').select('status').eq('job_id', jobId).single();
        if (checkJob?.status === 'SEARCHING_REFERRED') {
          console.log(`⏰ Referred artisan missed Job #${jobId}. Dropping to public T1.`);
          await supabase.from('jobs').update({ status: 'SEARCHING_T1', referred_artisan: null }).eq('job_id', jobId);
          triggerMatchmaker(jobId);
        }
      }, 10 * 60 * 1000);

      return;
    }

    console.log(`⚠️  Referred artisan ${job.referred_artisan} offline/busy. Falling to public waterfall.`);
  } else if (job.referred_artisan && !isDirectReferral) {
    console.log(`🛡️  Proxy job — Agent +${job.referred_artisan} handles client. Using public waterfall.`);
  }

  // --- STANDARD TIERED WATERFALL ---
  const currentTier = parseInt(job.status.split('_T')[1]) || 1;

  // Fetch available artisans for this category AND zone
  const { data: allAvailable } = await supabase
    .from('artisan_meta')
    .select('artisan_id, phone_number, tier, trust_score')
    .ilike('category', job.category)
    .ilike('zone', job.zone)
    .eq('is_available', true);

  if (!allAvailable || allAvailable.length === 0) {
    return handleNoArtisans(jobId, job);
  }

  // Filter for current tier
  let targetGroup = allAvailable.filter(a => a.tier === currentTier);

  // Fast-forward if tier is empty
  if (targetGroup.length === 0) {
    if (currentTier < 3) {
      console.log(`⏩ Tier ${currentTier} empty for Job #${jobId}. Fast-forwarding.`);
      await supabase.from('jobs').update({
        status: `SEARCHING_T${currentTier + 1}`,
        updated_at: new Date().toISOString()
      }).eq('job_id', jobId);
      return triggerMatchmaker(jobId);
    }
    return handleNoArtisans(jobId, job);
  }

  // Score, sort, and cap at top 3
  targetGroup = targetGroup
    .map(a => ({ ...a, score: calculateMatchScore(a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // Blast alerts
  for (const artisan of targetGroup) {
    await sendTemplateMessage(artisan.phone_number, 'nexa_job_alert', [job.zone, job.problem_description]);
  }

  console.log(`⏳ Tier ${currentTier} alerts sent for Job #${jobId}. 10-minute clock started.`);

  // 10-minute escalation timer
  setTimeout(async () => {
    const { data: currentJobState } = await supabase.from('jobs').select('status').eq('job_id', jobId).single();

    if (currentJobState?.status === `SEARCHING_T${currentTier}`) {
      console.log(`⏰ Tier ${currentTier} timeout for Job #${jobId}.`);
      if (currentTier < 3) {
        await supabase.from('jobs').update({
          status: `SEARCHING_T${currentTier + 1}`,
          updated_at: new Date().toISOString()
        }).eq('job_id', jobId);
        triggerMatchmaker(jobId);
      } else {
        const { data: finalJob } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
        handleNoArtisans(jobId, finalJob);
      }
    } else {
      console.log(`✅ Job #${jobId} already moved on. Timer ignored.`);
    }
  }, 10 * 60 * 1000);
}

/**
 * Called when the entire waterfall dries up with no takers.
 */
async function handleNoArtisans(jobId, job) {
  console.log(`❌ Waterfall dry for Job #${jobId}. Failing.`);

  if (!job) {
    const { data } = await supabase.from('jobs').select('*').eq('job_id', jobId).single();
    job = data;
  }
  if (!job) return;

  await supabase.from('jobs').update({ status: 'FAILED_NO_ARTISANS', updated_at: new Date().toISOString() }).eq('job_id', jobId);
  await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.client_phone);

  // Also unblock agent if this was a proxy job
  if (job.referred_artisan && !job.referred_artisan.startsWith('NX-')) {
    await supabase.from('profiles').update({ current_status: 'IDLE' }).eq('phone_number', job.referred_artisan);
  }

  const preFilledMsg = encodeURIComponent(`Hi Nexa Support, my ${job.category} request in ${job.zone} couldn't find an artisan. Can you help?`);
  const waLink = `https://wa.me/${CS_NUMBER}?text=${preFilledMsg}`;
  const failureMsg = `⚠️ *No Available Artisans*\n\nAll our ${job.category} pros in your zone are currently busy.\n\nTap here to chat with our support team:\n\n🔗 ${waLink}`;

  if (job.referred_artisan && !job.referred_artisan.startsWith('NX-')) {
    await sendMessage(job.referred_artisan, failureMsg);
    await sendMessage(job.client_phone, `⚠️ We couldn't find an available artisan right now. Your agent has been notified and is contacting support.`);
  } else {
    await sendMessage(job.client_phone, failureMsg);
  }
}

module.exports = { triggerMatchmaker };
