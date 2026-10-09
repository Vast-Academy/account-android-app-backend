const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Delivery = require('../models/MessageDelivery');
const {verifyToken} = require('../middleware/authMiddleware');
const {acceptDelivery, advanceStatus, dispatchOne, deliveryPayload, relayReceipt, fail} = require('../services/deliveryService');
const respondError = (res, error) => res.status(error.statusCode || 500).json({
  success: false, message: error.statusCode ? error.message : 'Delivery service unavailable',
});
router.post('/send', verifyToken, async (req, res) => {
  try {
    const senderId = String(req.user.uid);
    const {conversationId, receiverId, messageId, messageText, timestamp} = req.body || {};
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 250 ||
        typeof receiverId !== 'string' || receiverId === senderId ||
        conversationId !== [senderId, receiverId].sort().join('_') ||
        typeof messageText !== 'string' || !messageText.trim() || messageText.length > 4000 ||
        !Number.isSafeInteger(Number(timestamp)) || Number(timestamp) <= 0) {
      throw fail(400, 'Invalid message identity, content or timestamp');
    }
    const receiver = await User.findOne({firebaseUid: receiverId}).select('firebaseUid').lean();
    if (!receiver) throw fail(404, 'Receiver not found');
    const sender = await User.findOne({firebaseUid: senderId})
      .select('displayName username mobileNormalized mobile').lean();
    const payload = {
      type: 'chat_message', messageId, conversationId, senderId, receiverId,
      messageText: messageText.trim(), messageType: String(req.body.messageType || 'text'),
      timestamp: String(timestamp), senderName: sender?.displayName || sender?.username || 'Contact',
      senderPhone: String(sender?.mobileNormalized || sender?.mobile || ''),
      contactRecordId: String(req.body.contactRecordId || ''), eventId: messageId, notifVersion: 'v3',
    };
    const row = await acceptDelivery({messageId, conversationId, senderId, receiverId,
      messageText: payload.messageText, messageTimestamp: Number(timestamp), kind: 'chat',
      contentKey: payload.messageType, payload});
    // Await immediate dispatch; a separate durable worker owns retries.
    try { await dispatchOne(messageId); } catch (_) { /* inbox remains durable */ }
    const current = await Delivery.findOne({messageId}).select('status').lean();
    return res.json({success: true, messageId, status: current?.status || row.status,
      durable: true, protocolVersion: 2, queued: !['delivered', 'read'].includes(current?.status)});
  } catch (error) { return respondError(res, error); }
});
router.post('/delivery-receipt', verifyToken, async (req, res) => {
  try {
    const {messageId, status} = req.body || {};
    if (typeof messageId !== 'string') throw fail(400, 'messageId required');
    const row = await advanceStatus(messageId, req.user.uid, status);
    await relayReceipt(row);
    return res.json({success: true, status: row.status});
  } catch (error) { return respondError(res, error); }
});
// Each pass starts at the oldest unacknowledged row. Late commits are therefore
// recoverable even if an earlier pass already advanced beyond their ObjectId.
router.get('/inbox', verifyToken, async (req, res) => {
  try {
    const after = String(req.query.after || '');
    if (after && !/^[a-f0-9]{24}$/i.test(after)) throw fail(400, 'Invalid cursor');
    const rows = await Delivery.find({receiverId: req.user.uid,
      status: {$in: ['accepted', 'pushed', 'failed']}, ...(after ? {_id: {$gt: after}} : {}),
    }).sort({_id: 1}).limit(101).lean();
    const page = rows.slice(0, 100);
    return res.json({success: true, protocolVersion: 2,
      events: page.map(row => ({messageId: row.messageId, kind: row.kind || 'chat', data: deliveryPayload(row)})),
      nextCursor: rows.length > 100 ? String(page[page.length - 1]._id) : null});
  } catch (error) { return respondError(res, error); }
});
router.post('/statuses', verifyToken, async (req, res) => {
  try {
    const ids = req.body?.messageIds;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')) {
      throw fail(400, 'At most 100 message IDs required');
    }
    const rows = await Delivery.find({senderId: req.user.uid, messageId: {$in: ids}})
      .select('messageId conversationId status').lean();
    return res.json({success: true, statuses: rows});
  } catch (error) { return respondError(res, error); }
});
// Compatibility endpoint for older installed clients.
router.get('/pending-sync', verifyToken, async (req, res) => {
  try {
    const conversationId = String(req.query.conversationId || '');
    if (!conversationId) throw fail(400, 'conversationId required');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = await Delivery.find({conversationId, receiverId: req.user.uid,
      kind: {$ne: 'ledger'}, messageTimestamp: {$gt: Math.max(0, Number(req.query.sinceTimestamp) || 0)},
    }).sort({messageTimestamp: 1, _id: 1}).limit(limit).lean();
    return res.json({success: true, messages: rows.map(row => ({
      ...deliveryPayload(row), receiverId: row.receiverId,
      timestamp: row.messageTimestamp, status: row.status,
    })), count: rows.length, conversationId});
  } catch (error) { return respondError(res, error); }
});
module.exports = router;
