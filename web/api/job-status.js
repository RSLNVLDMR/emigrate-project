import { get } from '@vercel/blob';

export const config = { runtime: 'edge' };

async function fetchJson(key){
  const b = await get(key);
  if(!b?.downloadUrl) return null;
  const r = await fetch(b.downloadUrl);
  if(!r.ok) return null;
  return await r.json();
}

export default async function handler(req){
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId') || '';
  if(!jobId) return new Response(JSON.stringify({ error:'jobId required' }), { status:400 });
  const job = await fetchJson(`jobs/${jobId}.json`);
  if(!job) return new Response(JSON.stringify({ error:'job not found' }), { status:404 });
  if(job.status === 'done'){
    const res = await fetchJson(`results/${jobId}.json`);
    return new Response(JSON.stringify({ status:'done', result: res?.result }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8' } });
  }
  return new Response(JSON.stringify({ status: job.status || 'queued' }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8' } });
}
