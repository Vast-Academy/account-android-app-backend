// Run continuously, never as an unawaited serverless timer.
require('dotenv').config();
const mongoose = require('mongoose');
const {setTimeout: delay} = require('node:timers/promises');
const {dispatchBatch} = require('../services/deliveryService');
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  while (!stopping) {
    try { await dispatchBatch(); }
    catch (_) { console.error('Delivery dispatch failed; retrying'); }
    if (!stopping) await delay(1000);
  }
  await mongoose.disconnect();
}
main().catch(() => { console.error('Delivery worker startup failed'); process.exitCode = 1; });
