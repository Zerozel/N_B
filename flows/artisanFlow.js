const supabase = require('../config/supabase');
const { sendMessage } = require('../utils/whatsapp');

async function handleArtisanFlow(user, from, text) {
  const cleanText = text.trim().replace(/\*/g, '').toUpperCase();
  const originalText = text.trim();

  // --- PHASE C: ARTISAN FASTEST-FINGER CLAIM ---
  if (cleanText.startsWith('ACCEPT ')) {
    const jobId = cleanText.split(' ')[1];
    
    const { data: ticket } = await supabase.from('job_tickets').select('*').eq('job_id', jobId).single();
    
    if (!ticket) {
      await sendMessage(from, '❌ Invalid Job ID.');
      return true;
    }
    
    // Ensure it's still available (We are adding PENDING_PREFERRED for your Deep-Link strategy later)
    if (ticket.status !== 'BROADCASTED' && ticket.status !== 'PENDING_PREFERRED_ARTISAN') {
      await sendMessage(from, '🔒 Sorry, this job has already been claimed by another artisan or cancelled.');
      return true;
    }
    
    await supabase.from('job_tickets').update({
      status: 'PENDING_CLIENT_APPROVAL',
      awarded_artisan: from
    }).eq('job_id', jobId);
    
    await sendMessage(from, '✅ *Job Claimed!* \n\nWe are asking the client for final approval. Please stand by, we will send you their contact shortly.');
    
    const { data: artisanProfile } = await supabase
      .from('artisans')
      .select('name, rating')
      .eq('phone_number', from)
      .limit(1)
      .single();
    
    await supabase.from('users').update({ status: `AWAITING_APPROVAL_${jobId}` }).eq('phone_number', ticket.client_phone);
    
    await sendMessage(
      ticket.client_phone,
      `🔔 *Good news! We found an available ${ticket.category}.*\n\n🧑‍🔧 *Personnel:* ${artisanProfile?.name || 'Nexa Artisan'}\n⭐ *Rating:* ${artisanProfile?.rating || 'New'}/5.0\n✅ *Nexa Verified*\n\nReply *YES* to approve and receive their contact details, or *NO* to cancel.`
    );
    return true;
  }

  // --- PHASE D: CLIENT DOUBLE-OPT-IN APPROVAL ---
  if (user.status.startsWith('AWAITING_APPROVAL_')) {
    const jobId = user.status.split('_')[2];
    
    if (cleanText === 'YES') {
      const { data: ticket } = await supabase.from('job_tickets').select('*').eq('job_id', jobId).single();
      if (!ticket) {
        await sendMessage(from, '❌ Error locating job ticket. Please type "menu".');
        return true;
      }
      
      await supabase.from('job_tickets').update({ status: 'MATCHED' }).eq('job_id', jobId);
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
      
      await supabase.from('artisans').update({ is_available: false }).eq('phone_number', ticket.awarded_artisan);
      await supabase.from('users').update({ status: `ACTIVE_JOB_${jobId}` }).eq('phone_number', ticket.awarded_artisan);
      
      await sendMessage(from, `✅ *Match Confirmed!*\n\nYour artisan is ready. Please call or message them now:\n📞 *WhatsApp:* +${ticket.awarded_artisan}\n\n💬 *Need help? Chat with Nexa Customer Service: 09045955670*`);
      
      await sendMessage(
        ticket.awarded_artisan,
        `✅ *Job #${jobId} Approved!*\n\nThe client is expecting you. Reach out to them immediately to arrange pricing and timing:\n📞 *Client Number:* +${ticket.client_phone}\n📍 *Location:* ${ticket.location}\n📝 *Issue:* ${ticket.description}\n\n⚠️ *IMPORTANT: You will NOT receive any new job alerts until this ticket is closed.*\n\nReply to this chat with:\n*1* - Job Completed\n*2* - Job Cancelled`
      );
    } else if (cleanText === 'NO') {
      await sendMessage(from, '❌ Approval cancelled. The job has been aborted. Reply "menu" to start a new search.');
      
      // UPGRADE: Inform the artisan that the client rejected the match so they aren't waiting forever
      const { data: ticket } = await supabase.from('job_tickets').select('*').eq('job_id', jobId).single();
      if(ticket) {
          await supabase.from('job_tickets').update({ status: 'CANCELLED_BY_CLIENT' }).eq('job_id', jobId);
          await sendMessage(ticket.awarded_artisan, `⚠️ The client cancelled Job #${jobId}. You are back in the available pool.`);
      }
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
    } else {
        await sendMessage(from, '❌ Please reply with exactly *YES* or *NO*.');
    }
    return true;
  }

  // --- PHASE E: ARTISAN JOB COMPLETION TRACKER ---
  if (user.status.startsWith('ACTIVE_JOB_')) {
    const jobId = user.status.split('_')[2];

    if (originalText === '1' || originalText === '2') {
      const reportedStatus = originalText === '1' ? 'COMPLETED' : 'CANCELLED';

      await supabase.from('job_tickets').update({ status: `PENDING_VERIFICATION_${reportedStatus}` }).eq('job_id', jobId);
      await supabase.from('artisans').update({ is_available: true }).eq('phone_number', from);
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);

      await sendMessage(from, `✅ System Updated! Job #${jobId} reported as ${reportedStatus}. You are now back in the available pool for new requests.`);

      const { data: ticket } = await supabase.from('job_tickets').select('client_phone').eq('job_id', jobId).single();
      if (ticket && ticket.client_phone) {
        await supabase.from('users').update({ status: `VERIFYING_JOB_${jobId}_${reportedStatus}` }).eq('phone_number', ticket.client_phone);
        const actionText = reportedStatus === 'COMPLETED' ? 'COMPLETED the service' : 'CANCELLED the service';
        await sendMessage(ticket.client_phone, `🔔 *Job Verification Required!*\n\nThe artisan reported that they have *${actionText}* for Job #${jobId}.\n\nPlease verify by replying with a number:\n*1* - Yes, I confirm this.\n*2* - No, I dispute this (Report an issue).`);
      }
    } else {
      await sendMessage(from, '❌ Invalid choice.\n\n⚠️ *You cannot receive new jobs until you close this one.*\n\nPlease reply with:\n*1* - Job Completed\n*2* - Job Cancelled');
    }
    return true;
  }

  // --- PHASE F: CLIENT VERIFICATION & DISPUTE ---
  if (user.status.startsWith('VERIFYING_JOB_')) {
    const parts = user.status.split('_');
    const jobId = parts[2];
    const reportedStatus = parts[3]; 

    if (originalText === '1') {
      await supabase.from('job_tickets').update({ status: reportedStatus }).eq('job_id', jobId);
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, '✅ Thank you for confirming! Your ticket is now officially closed. Reply "menu" anytime to request a new service.');
    } else if (originalText === '2') {
      await supabase.from('job_tickets').update({ status: 'DISPUTED' }).eq('job_id', jobId);
      await supabase.from('users').update({ status: 'IDLE' }).eq('phone_number', from);
      await sendMessage(from, `⚠️ We have logged this job as DISPUTED. A Nexa Customer Service agent will review the issue and contact you shortly to resolve this.\n\n💬 *Direct support line: 09045955670*`);
    } else {
      await sendMessage(from, '❌ Invalid choice. Please reply with *1* to Confirm, or *2* to Dispute.');
    }
    return true;
  }

  return false; // Tells the router this state wasn't handled here
}

module.exports = { handleArtisanFlow };
