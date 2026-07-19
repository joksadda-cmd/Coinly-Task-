// lib/adminState.js — Tracks the admin's current multi-step conversation
// (e.g. "creating a task" walks through type → title → link → slots →
// photo across several messages). Serverless functions have no memory
// between requests, so this state MUST live in the database.

export async function getAdminState(db, adminId) {
  return db.collection('adminState').findOne({ adminId });
}

export async function setAdminState(db, adminId, step, data = {}) {
  await db.collection('adminState').updateOne(
    { adminId },
    { $set: { adminId, step, data, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function clearAdminState(db, adminId) {
  await db.collection('adminState').deleteOne({ adminId });
}
