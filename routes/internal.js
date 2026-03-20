const express = require('express');
const router = express.Router();
const { runFcmTokenAudit } = require('../services/fcmTokenAuditService');

const verifyCronSecret = (req, res, next) => {
  const expected = String(process.env.CRON_SECRET || '').trim();
  const received = String(req.headers.authorization || '').trim();

  if (!expected || received !== `Bearer ${expected}`) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized',
    });
  }

  next();
};

router.get('/fcm-token-audit', verifyCronSecret, async (req, res) => {
  try {
    const parsedBatchSize = Number(req.query?.batchSize || 0);
    const summary = await runFcmTokenAudit({
      batchSize: parsedBatchSize > 0 ? parsedBatchSize : undefined,
      reason: String(req.query?.reason || 'cron'),
    });

    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error('[FCM_AUDIT] Cron route failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'FCM token audit failed',
      error: error.message,
    });
  }
});

module.exports = router;
