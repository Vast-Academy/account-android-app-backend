const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {MongoMemoryServer} = require('mongodb-memory-server');
const mongoose = require('mongoose');
let mongo;
let push = async () => 'push-id';
const firebasePath = require.resolve('../config/firebase');
require.cache[firebasePath] = {id: firebasePath, filename: firebasePath, loaded: true,
  exports: {messaging: () => ({send: (...args) => push(...args)}),
    auth: () => ({verifyIdToken: async token => ({uid: token})})}};
const Delivery = require('../models/MessageDelivery');
const User = require('../models/User');
const service = require('../services/deliveryService');
const envelope = id => ({messageId: id, conversationId: 'A_B', senderId: 'A', receiverId: 'B',
  messageText: 'hello', messageTimestamp: 123, kind: 'chat', contentKey: 'text',
  payload: {type: 'chat_message', messageId: id, receiverId: 'B', messageText: 'hello'}});

before(async () => {
  // Isolated throwaway mongod; never point these tests at a real database.
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('delivery_test'));
  // User's partial $ne indexes are rejected by mongod; delivery tests need only its collection.
  await Promise.all([Delivery.init(), User.createCollection()]);
  await User.create({firebaseUid: 'B', email: 'b@example.test', displayName: 'B',
    fcmToken: 'old-token', mobileNormalized: '+911234567890', phoneOwnershipState: 'active'});
});
after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('concurrent identical sends produce one durable record and retry obligation', async () => {
  await Promise.all(Array.from({length: 12}, () => service.acceptDelivery(envelope('same'))));
  assert.equal(await Delivery.countDocuments({messageId: 'same'}), 1);
  const row = await Delivery.findOne({messageId: 'same'}).lean();
  assert.equal(row.status, 'accepted');
  assert.equal(row.expiresAt, null);
  assert.ok(row.nextPushAt);
});
test('message ID cannot overwrite content or another sender identity', async () => {
  await assert.rejects(service.acceptDelivery({...envelope('same'), messageText: 'changed'}), {statusCode: 409});
  await assert.rejects(service.acceptDelivery({...envelope('same'), senderId: 'intruder'}), {statusCode: 409});
  assert.equal((await Delivery.findOne({messageId: 'same'})).messageText, 'hello');
});
test('read wins over concurrent delivered receipts and repeated original send', async () => {
  await service.acceptDelivery(envelope('race'));
  await Promise.all([service.advanceStatus('race', 'B', 'read'),
    service.advanceStatus('race', 'B', 'delivered'), service.acceptDelivery(envelope('race'))]);
  assert.equal((await Delivery.findOne({messageId: 'race'})).status, 'read');
  await assert.rejects(service.advanceStatus('race', 'intruder', 'read'), {statusCode: 404});
});
test('two workers lease once; receipt during push is never downgraded', async () => {
  await service.acceptDelivery(envelope('lease'));
  let calls = 0;
  push = async () => {calls++; await service.advanceStatus('lease', 'B', 'read'); return 'ok';};
  await Promise.all([service.dispatchOne('lease'), service.dispatchOne('lease')]);
  assert.equal(calls, 1);
  assert.equal((await Delivery.findOne({messageId: 'lease'})).status, 'read');
});
test('invalid old token cannot clear refreshed token or alter phone ownership', async () => {
  await service.acceptDelivery(envelope('token'));
  push = async () => {
    await User.updateOne({firebaseUid: 'B'}, {$set: {fcmToken: 'new-token'}});
    throw Object.assign(new Error('invalid'), {code: 'messaging/registration-token-not-registered'});
  };
  await service.dispatchOne('token');
  const receiver = await User.findOne({firebaseUid: 'B'}).lean();
  assert.equal(receiver.fcmToken, 'new-token');
  assert.equal(receiver.phoneOwnershipState, 'active');
  const row = await Delivery.findOne({messageId: 'token'}).lean();
  assert.equal(row.status, 'accepted');
  assert.ok(row.nextPushAt.getTime() > Date.now());
});
test('missing token retains message without expiry and waits for retry', async () => {
  await User.updateOne({firebaseUid: 'B'}, {$set: {fcmToken: null}});
  await service.acceptDelivery(envelope('offline'));
  await service.dispatchOne('offline');
  const row = await Delivery.findOne({messageId: 'offline'}).lean();
  assert.equal(row.status, 'accepted');
  assert.equal(row.expiresAt, null);
  assert.equal(row.lastError, 'push_token_missing');
});
test('re-push stops after the attempt cap while the message stays in the inbox', async () => {
  await User.updateOne({firebaseUid: 'B'}, {$set: {fcmToken: 'live-token'}});
  push = async () => { throw Object.assign(new Error('unavailable'), {code: 'messaging/unavailable'}); };
  try {
    await service.acceptDelivery(envelope('capped'));
    const due = () => Delivery.updateOne({messageId: 'capped'}, {$set: {nextPushAt: new Date(0)}});
    for (let attempt = 1; attempt <= service.MAX_PUSH_ATTEMPTS; attempt++) {
      await due();
      assert.equal(await service.dispatchOne('capped'), true);
    }
    await due();
    assert.equal(await service.dispatchOne('capped'), false);
    const row = await Delivery.findOne({messageId: 'capped'}).lean();
    assert.equal(row.retryCount, service.MAX_PUSH_ATTEMPTS);
    assert.equal(row.status, 'accepted');
  } finally { push = async () => 'push-id'; }
});
test('inbox and status routes isolate accounts and recover missing receipt pushes', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/messages', require('../routes/messages'));
  const server = await new Promise(resolve => {const s = app.listen(0, '127.0.0.1', () => resolve(s));});
  const base = `http://127.0.0.1:${server.address().port}/messages`;
  try {
    const inbox = await (await fetch(base + '/inbox', {headers: {Authorization: 'Bearer B'}})).json();
    assert.ok(inbox.events.some(event => event.messageId === 'offline'));
    const outsider = await (await fetch(base + '/inbox', {headers: {Authorization: 'Bearer C'}})).json();
    assert.equal(outsider.events.length, 0);
    const statuses = await (await fetch(base + '/statuses', {method: 'POST',
      headers: {Authorization: 'Bearer A', 'Content-Type': 'application/json'},
      body: JSON.stringify({messageIds: ['race', 'lease']})})).json();
    assert.equal(statuses.statuses.length, 2);
    assert.ok(statuses.statuses.every(row => row.status === 'read'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
