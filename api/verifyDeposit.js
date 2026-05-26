// api/verifyDeposit.js
// Checks TON wallet for deposits, matches memo to userId

export default async function handler(req, res) {
  const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET;
  const TON_API_KEY    = process.env.TON_API_KEY;
  const FIREBASE_URL   = `https://coinly-task-default-rtdb.firebaseio.com`;
  const TON_TO_DIAMOND = 1333;

  try {
    const tonRes = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${DEPOSIT_WALLET}&limit=30`,
      { headers: { 'X-API-Key': TON_API_KEY } }
    );
    const tonData = await tonRes.json();
    if (!tonData.ok) return res.status(500).json({ error: 'TON API error' });

    let processed = 0;

    for (const tx of tonData.result) {
      const inMsg = tx.in_msg;
      if (!inMsg?.value || parseInt(inMsg.value) <= 0) continue;

      const txHash    = tx.transaction_id?.hash;
      const memo      = inMsg.message?.trim();
      const tonAmount = parseInt(inMsg.value) / 1e9;

      if (!memo || !txHash) continue;

      // Check already processed
      const chkRes = await fetch(`${FIREBASE_URL}/processed_txs/${txHash}.json`);
      const chkData = await chkRes.json();
      if (chkData) continue;

      // Check if memo is a task payment (starts with TASK_)
      if (memo.startsWith('TASK_')) {
        // Find pending task payment
        const tpRes  = await fetch(`${FIREBASE_URL}/task_payments.json?orderBy="memo"&equalTo="${memo}"&limitToFirst=1`);
        const tpData = await tpRes.json();
        if (tpData) {
          const tpId  = Object.keys(tpData)[0];
          const tp    = tpData[tpId];
          const uid   = tp.userId;

          // Find and activate the pending task
          const tasksRes  = await fetch(`${FIREBASE_URL}/tasks.json?orderBy="createdBy"&equalTo="${uid}"&limitToFirst=10`);
          const tasksData = await tasksRes.json();

          if (tasksData) {
            for (const [tid, task] of Object.entries(tasksData)) {
              if (task.paymentStatus === 'pending') {
                await fetch(`${FIREBASE_URL}/tasks/${tid}.json`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ isApproved: true, paymentStatus: 'paid' })
                });
                await fetch(`${FIREBASE_URL}/task_payments/${tpId}.json`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'confirmed', txHash })
                });
                break;
              }
            }
          }
        }
      } else {
        // Regular diamond deposit — memo = userId
        const diamond = Math.floor(tonAmount * TON_TO_DIAMOND);
        const uid     = memo;

        // Get user
        const uRes  = await fetch(`${FIREBASE_URL}/users/${uid}.json`);
        const uData = await uRes.json();
        if (!uData) continue;

        const current = parseFloat(uData.diamondBalance || 0);

        // Update diamond balance
        await fetch(`${FIREBASE_URL}/users/${uid}.json`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ diamondBalance: current + diamond })
        });

        // Log transaction
        await fetch(`${FIREBASE_URL}/transactions.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: uid, type: 'Deposit',
            details: `${tonAmount.toFixed(3)} TON`,
            diamondAmount: diamond, txHash,
            createdAt: Date.now()
          })
        });
      }

      // Mark tx as processed
      await fetch(`${FIREBASE_URL}/processed_txs/${txHash}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memo, tonAmount, processedAt: Date.now() })
      });

      processed++;
    }

    return res.status(200).json({ ok: true, processed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
