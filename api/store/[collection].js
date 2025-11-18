// Vercel Serverless Function using Vercel Blob (deterministic pathnames)
// Endpoints:
//   GET  /api/store/:collection         -> returns JSON array (or [])
//   POST /api/store/:collection         -> body: { op: 'add'|'update'|'delete'|'replace', id?, payload? }
// Notes:
// - We store one JSON per collection at path: opsdriver/<collection>.json
// - 'replace' allows uploading whole array in one shot (admin usage).

import { put, list, del } from '@vercel/blob';

const BUCKET_PREFIX = 'opsdriver/';

async function readList(collection) {
  const pathname = `${BUCKET_PREFIX}${collection}.json`;
  // Find existing blob by deterministic pathname (no random suffix)
  const { blobs } = await list({ prefix: pathname });
  const blob = blobs?.find(b => b.pathname === pathname);
  if (!blob) return [];
  const r = await fetch(blob.url, { cache: 'no-store' });
  if (!r.ok) return [];
  return await r.json();
}

async function writeList(collection, listData) {
  const pathname = `${BUCKET_PREFIX}${collection}.json`;
  await put(pathname, JSON.stringify(listData, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false, // deterministic
  });
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    const { collection } = req.query;
    if (!collection) {
      res.status(400).json({ error: 'collection required' });
      return;
    }
    if (req.method === 'GET') {
      const data = await readList(collection);
      res.setHeader('content-type', 'application/json');
      res.status(200).send(JSON.stringify(data));
      return;
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const op = body.op;
      let listData = await readList(collection);

      if (op === 'replace' && Array.isArray(body.items)) {
        listData = body.items;
      } else if (op === 'add') {
        const nextId = (listData.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1);
        listData.push({ id: nextId, createdAt: new Date().toISOString(), ...body.payload });
      } else if (op === 'update') {
        const idx = listData.findIndex(x => x.id === body.id);
        if (idx >= 0) listData[idx] = { ...listData[idx], ...body.payload, updatedAt: new Date().toISOString() };
      } else if (op === 'delete') {
        const idx = listData.findIndex(x => x.id === body.id);
        if (idx >= 0) listData.splice(idx, 1);
      } else {
        res.status(400).json({ error: 'invalid op' });
        return;
      }

      await writeList(collection, listData);
      res.setHeader('content-type', 'application/json');
      res.status(200).send(JSON.stringify({ ok: true }));
      return;
    }
    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
