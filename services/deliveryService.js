const {createHash, randomUUID} = require('node:crypto');
const Delivery = require('../models/MessageDelivery');
const User = require('../models/User');
const admin = require('../config/firebase');
const {isInvalidFcmTokenError} = require('./fcmTokenState');

const pendingStatuses = ['accepted', 'pushed', 'failed'];
const statusPredecessors = {
  pushed: ['accepted', 'failed'],
  delivered: ['accepted', 'pushed', 'failed'],
  read: ['accepted', 'pushed', 'failed', 'delivered'],
};
const fail = (statusCode, message) => Object.assign(new Error(message), {statusCode});
const eventKey = (senderId, key) => 'ledger_' + createHash('sha256')
  .update(JSON.stringify([senderId, key])).digest('hex');

// Store the immutable content and the retry obligation in ONE document. A
// request retry must neither overwrite contents nor reset delivered/read.
async function acceptDelivery(input) {
  const immutable = [input.kind, input.conversationId, input.senderId,
    input.receiverId, input.messageText, input.messageTimestamp, input.contentKey];
  const payloadHash = createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
  let row;
  try {
    row = await Delivery.findOneAndUpdate({messageId: input.messageId}, {
      $setOnInsert: {
        messageId: input.messageId, conversationId: input.conversationId,
        senderId: input.senderId, receiverId: input.receiverId,
        messageText: input.messageText || '', messageTimestamp: input.messageTimestamp,
        kind: input.kind, payload: input.payload, payloadHash,
        status: 'accepted', nextPushAt: new Date(), expiresAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    }, {upsert: true, new: true, runValidators: true, timestamps: false});
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await Delivery.findOne({messageId: input.messageId});
  }
  if (!row || row.senderId !== input.senderId || row.receiverId !== input.receiverId ||
      row.conversationId !== input.conversationId ||
      (row.payloadHash && row.payloadHash !== payloadHash) ||
      (!row.payloadHash && (row.messageText !== input.messageText ||
        Number(row.messageTimestamp) !== Number(input.messageTimestamp)))) {
    throw fail(409, 'Operation ID already belongs to different content');
  }
  // Upgrade still-existing legacy records without resetting their status.
  if (!row.payloadHash) {
    await Delivery.updateOne({_id: row._id, payloadHash: {$in: ['', null]}}, {
      $set: {payloadHash, payload: input.payload, kind: input.kind, expiresAt: null},
    });
  }
  return row;
}

async function advanceStatus(messageId, receiverId, status) {
  if (!['delivered', 'read'].includes(status)) throw fail(400, 'Invalid receipt status');
  const now = new Date();
  const update = {status, expiresAt: null, lastError: null, leaseId: null, leaseUntil: null};
  if (status === 'read') update.readAt = now;
  await Delivery.updateOne({messageId, receiverId, status: {$in: statusPredecessors[status]}}, {$set: update});
  await Delivery.updateOne({messageId, receiverId, deliveredAt: null,
    status: {$in: ['delivered', 'read']}}, {$set: {deliveredAt: now}});
  const row = await Delivery.findOne({messageId, receiverId}).lean();
  if (!row) throw fail(404, 'Delivery not found for this receiver');
  return row;
}

function deliveryPayload(row) {
  if (row.payload) return row.payload;
  return {type: 'chat_message', messageId: row.messageId,
    conversationId: row.conversationId, senderId: row.senderId,
    receiverId: row.receiverId, messageText: row.messageText,
    timestamp: String(row.messageTimestamp), eventId: row.messageId, notifVersion: 'v3'};
}

async function dispatchOne(messageId) {
  const now = new Date();
  const leaseId = randomUUID();
  const row = await Delivery.findOneAndUpdate({
    ...(messageId ? {messageId} : {}), status: {$in: pendingStatuses},
    $and: [{$or: [{nextPushAt: {$lte: now}}, {nextPushAt: null}]},
      {$or: [{leaseUntil: {$lte: now}}, {leaseUntil: null}]}],
  }, {$set: {leaseId, leaseUntil: new Date(Date.now() + 60000)}},
  {new: true, sort: {nextPushAt: 1, _id: 1}}).lean();
  if (!row) return false;
  let token;
  let pushed = false;
  let lastError = null;
  try {
    const receiver = await User.findOne({firebaseUid: row.receiverId}).select('fcmToken').lean();
    token = receiver?.fcmToken;
    if (!token) {
      lastError = 'push_token_missing';
    } else {
      const data = Object.fromEntries(Object.entries(deliveryPayload(row))
        .map(([key, value]) => [key, String(value ?? '')]));
      // Large events remain recoverable from the inbox. Push only a wakeup
      // envelope when the FCM data limit would otherwise reject the event.
      const pushData = Buffer.byteLength(JSON.stringify(data), 'utf8') > 3500
        ? {type: 'delivery_sync', receiverId: row.receiverId, eventId: row.messageId}
        : data;
      await admin.messaging().send({token, data: pushData, android: {priority: 'high'}});
      pushed = true;
    }
  } catch (error) {
    lastError = String(error.code || 'push_failed').slice(0, 100);
    if (token && isInvalidFcmTokenError(error)) {
      // Compare the failed token: a concurrent token refresh must survive.
      // Push failure is NOT evidence that phone/account ownership has changed.
      await User.updateOne({firebaseUid: row.receiverId, fcmToken: token}, {
        $set: {fcmToken: null, fcmTokenStatus: 'error', fcmTokenLastError: lastError},
      });
    }
  }
  const retryMs = Math.min(300000, 10000 * 2 ** Math.min(Number(row.retryCount || 0), 5));
  // Never overwrite an acknowledgement that arrived while FCM was in flight.
  const state = {leaseId: null, leaseUntil: null, lastError,
    nextPushAt: new Date(Date.now() + retryMs), expiresAt: null};
  if (pushed) state.status = 'pushed';
  await Delivery.updateOne({_id: row._id, leaseId, status: {$in: pendingStatuses}}, {
    $set: state, $inc: {retryCount: 1},
  });
  return true;
}

async function dispatchBatch({limit = 50, budgetMs = 20000} = {}) {
  const deadline = Date.now() + budgetMs;
  let count = 0;
  while (count < limit && Date.now() < deadline && await dispatchOne()) count++;
  return {count};
}

async function relayReceipt(row) {
  const sender = await User.findOne({firebaseUid: row.senderId}).select('fcmToken').lean();
  if (!sender?.fcmToken) return;
  try {
    await admin.messaging().send({token: sender.fcmToken, data: {
      type: 'delivery_receipt', messageId: row.messageId, status: row.status,
      conversationId: row.conversationId, receiverId: row.senderId,
      eventId: `${row.messageId}:${row.status}`, notifVersion: 'v3',
    }, android: {priority: 'normal'}});
  } catch (_) {
    // Sender status reconciliation is authoritative; this is only a hint.
  }
}

module.exports = {acceptDelivery, advanceStatus, deliveryPayload, dispatchOne,
  dispatchBatch, relayReceipt, eventKey, fail};
