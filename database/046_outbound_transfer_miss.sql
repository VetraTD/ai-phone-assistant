-- ============================================================
-- Migration 046: outbound -- the transfer-miss clip (S3-4, spec §9.7, D6)
-- ============================================================
-- D6 ("one voice per call"): round 1 of live calls found an unanswered
-- transfer falling through to Twilio's own robotic <Say> -- the one place
-- left in the outbound flow where the caller heard a voice that was not
-- Ava's. The fix pre-renders a fixed "sorry, no one's free" line in the
-- call's own Live voice while the transfer rings (lib/outbound/dispatch.js),
-- the same way opener_audio/voicemail_audio already do, and the door plays
-- it back with <Play> when the transfer goes unanswered (lib/outbound/
-- doorRoutes.js's outbound-transfer-result route), falling back to today's
-- <Say> only when there is no stored clip.
--
-- Same shape as opener_audio/voicemail_audio: raw mu-law bytes, written by
-- storeAttemptAudio, read back by the signed media door, and cleared
-- unconditionally by post-call's finalizeAttemptResult once the attempt ends
-- (services/db.js) -- an unanswered-transfer clip is never needed again once
-- the call is over.

ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS transfer_miss_audio bytea;
