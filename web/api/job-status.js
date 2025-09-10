import { get } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    const jobId = (req.query && req.query.jobId) || new URL(req.url, 'http://localhost').searchParams.get('jobId');
    if (!jobId) {
      res.status(400).json({ error: 'jobId required' });
      return;
    }

    const job = await fetchJson(`jobs/${jobId}.json`);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    if (job.status === 'done') {
      const rst = await fetchJson(`results/${jobId}.json`);
      res.status(200).json({ status: 'done', result: rst?.result });
      return;
    }
    res.status(200).json({ status: job.status || 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'internal error' });
  }
}

async function fetchJson(key) {
  const b = await get(key);
  if (!b?.downloadUrl) return null;
  const r = await fetch(b.downloadUrl);
  if (!r.ok) return null;
  return await r.json();
}
