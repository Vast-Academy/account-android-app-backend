#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const User = require('../models/User');

const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const dryRun = !isApply;

const asTime = value => {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

const pickWinnerAndLosers = users => {
  const sorted = [...users].sort((a, b) => {
    const at = Math.max(
      asTime(a.fcmTokenUpdatedAt),
      asTime(a.lastTokenSeenAt),
      asTime(a.lastLogin),
      asTime(a.updatedAt),
    );
    const bt = Math.max(
      asTime(b.fcmTokenUpdatedAt),
      asTime(b.lastTokenSeenAt),
      asTime(b.lastLogin),
      asTime(b.updatedAt),
    );
    return bt - at;
  });
  return {
    winner: sorted[0] || null,
    losers: sorted.slice(1),
  };
};

const main = async () => {
  const startedAt = Date.now();
  await connectDB();

  try {
    const groups = await User.aggregate([
      {$match: {fcmToken: {$type: 'string', $ne: ''}}},
      {
        $group: {
          _id: '$fcmToken',
          users: {
            $push: {
              _id: '$_id',
              firebaseUid: '$firebaseUid',
              fcmTokenUpdatedAt: '$fcmTokenUpdatedAt',
              lastTokenSeenAt: '$lastTokenSeenAt',
              lastLogin: '$lastLogin',
              updatedAt: '$updatedAt',
            },
          },
          count: {$sum: 1},
        },
      },
      {$match: {count: {$gt: 1}}},
      {$sort: {count: -1}},
    ]);

    console.log(`[TOKEN_DEDUPE] mode=${dryRun ? 'dry-run' : 'apply'}`);
    console.log(`[TOKEN_DEDUPE] duplicate groups: ${groups.length}`);

    let totalLosers = 0;
    let groupsProcessed = 0;
    const now = new Date();

    for (const group of groups) {
      const token = String(group?._id || '').trim();
      if (!token) {
        continue;
      }

      const users = Array.isArray(group?.users) ? group.users : [];
      if (users.length < 2) {
        continue;
      }

      const {winner, losers} = pickWinnerAndLosers(users);
      if (!winner || losers.length === 0) {
        continue;
      }

      groupsProcessed += 1;
      totalLosers += losers.length;
      const tokenSuffix = token.slice(-8);
      console.log(
        `[TOKEN_DEDUPE] token=...${tokenSuffix} keep=${String(
          winner?.firebaseUid || '',
        )} clear=${losers.length}`,
      );

      if (!dryRun) {
        const loserIds = losers.map(item => item?._id).filter(Boolean);
        if (loserIds.length) {
          await User.updateMany(
            {_id: {$in: loserIds}},
            {
              $set: {
                fcmToken: null,
                appInstallState: 'uninstalled',
                fcmTokenStatus: 'error',
                fcmTokenLastError: 'duplicate_token_cleanup',
                lastAuditResult: 'duplicate_token_cleanup',
                lastAuditAt: now,
                lastOnline: now,
                isOnline: false,
              },
            },
          );
        }
      }
    }

    const remainingDuplicates = await User.aggregate([
      {$match: {fcmToken: {$type: 'string', $ne: ''}}},
      {
        $group: {
          _id: '$fcmToken',
          count: {$sum: 1},
        },
      },
      {$match: {count: {$gt: 1}}},
      {$count: 'duplicateTokenGroups'},
    ]);

    const remaining = Number(remainingDuplicates?.[0]?.duplicateTokenGroups || 0);
    console.log(`[TOKEN_DEDUPE] groups processed: ${groupsProcessed}`);
    console.log(`[TOKEN_DEDUPE] users cleared: ${totalLosers}`);
    console.log(`[TOKEN_DEDUPE] remaining duplicate groups: ${remaining}`);
    console.log(
      `[TOKEN_DEDUPE] completed in ${Math.max(
        0,
        Math.round((Date.now() - startedAt) / 1000),
      )}s`,
    );

    if (dryRun) {
      console.log('[TOKEN_DEDUPE] dry-run only; no DB writes performed.');
      console.log('[TOKEN_DEDUPE] run with --apply to execute migration.');
    }
  } finally {
    await mongoose.connection.close();
  }
};

main().catch(error => {
  console.error('[TOKEN_DEDUPE] migration failed:', error?.message || error);
  process.exitCode = 1;
});

