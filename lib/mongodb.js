// lib/mongodb.js — MongoDB connection with caching for Vercel Serverless
//
// Why caching matters: every Vercel function invocation can spin up a new
// process (cold start). Without caching, we'd open a brand-new MongoDB
// connection on every single request — slow, and Atlas will eventually
// throttle/reject too many simultaneous connections.
//
// We use `global` to persist the connection across warm invocations of the
// SAME lambda instance. It won't persist across cold starts, but it saves
// us from reconnecting on every request within a warm instance's lifetime.

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error('❌ Missing MONGODB_URI environment variable. Set it in Vercel → Project → Settings → Environment Variables.');
}

// Reuse across warm invocations
let cached = global._coinlyMongo;
if (!cached) {
  cached = global._coinlyMongo = { client: null, db: null, promise: null };
}

/**
 * Returns a cached { client, db } pair, connecting only once per warm lambda.
 * Usage:
 *   const { db } = await connectToDatabase();
 *   const users = db.collection('users');
 */
export async function connectToDatabase() {
  if (cached.client && cached.db) {
    return { client: cached.client, db: cached.db };
  }

  if (!cached.promise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,       // Free-tier friendly — don't hog connections
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8000,
    });

    cached.promise = client.connect().then((connectedClient) => {
      // db() with no argument uses the database name from the connection
      // string (we set it to `coinlytask` — see MONGODB_URI in Vercel).
      const db = connectedClient.db();
      cached.client = connectedClient;
      cached.db = db;
      return { client: connectedClient, db };
    }).catch((err) => {
      // Reset so the next request can retry instead of being stuck on a
      // rejected promise forever.
      cached.promise = null;
      throw err;
    });
  }

  return cached.promise;
}
