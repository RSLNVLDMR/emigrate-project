const $ = s => document.querySelector(s);
const statusEl = $('#status');
let gsUri = null, objectName = null, op = null, outPrefix = null;

function setStatus(s){ statusEl.textContent = s; console.log('[status]', s); }

$('#upload').onclick = async () => {
  const f = $('#file').files[0];
  if (!f) return alert('Choose PDF or image');

  try {
    setStatus('signing…');
    const sign = await post('/api/gcs-sign-upload', { filename: f.name, contentType: f.type });
    if (sign.error) throw new Error(sign.error);

    setStatus('uploading to GCS…');
    const put = await fetch(sign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
    if (!put.ok) throw new Error(`GCS PUT failed: ${put.status} ${put.statusText}`);

    gsUri = sign.gsUri; objectName = sign.objectName;
    $('#meta').textContent = `Uploaded: ${gsUri}`;
    $('#start').disabled = false;
    setStatus('uploaded');
  } catch (e) {
    console.error(e);
    setStatus('error on upload');
    alert(e.message);
  }
};

$('#start').onclick = async () => {
  if (!gsUri) return;
  try {
    setStatus('starting OCR…');
    const start = await post('/api/docai-start', { gsUris: [gsUri] });
    if (start.error) throw new Error(start.error);
    op = start.operationName; outPrefix = start.outputPrefix;
    setStatus('processing…'); poll();
  } catch (e) {
    console.error(e); setStatus('error on start'); alert(e.message);
  }
};

async function poll() {
  try {
    const r = await fetch(`/api/docai-status?operationName=${encodeURIComponent(op)}&outputPrefix=${encodeURIComponent(outPrefix)}`).then(r=>r.json());
    if (r.done && !r.error) { setStatus('done'); render(r); }
    else if (r.error) { setStatus('error on status'); alert(JSON.stringify(r.error)); }
    else { setTimeout(poll, 3000); }
  } catch (e) {
    console.error(e); setStatus('error on poll'); alert(e.message);
  }
}

function render(r){
  const simple = r.simplified?.[0] || {};
  const raw = r.outputs?.[0] || {};
  $('#simple').innerHTML = `
    <div class="mono">pages: ${simple.pages || 0}</div>
    <h4>Key-Value pairs</h4>
    <ul>${(simple.kvPairs||[]).map(kv=>`<li><strong>${esc(kv.key)}</strong>: ${esc(kv.value)} <span class="pill">${(kv.confidence??'').toString().slice(0,5)}</span></li>`).join('')}</ul>
    <h4>Entities</h4>
    <ul>${(simple.entities||[]).map(e=>`<li>${esc(e.type)} → ${esc(e.mentionText)} <span class="pill">${(e.confidence??'').toString().slice(0,5)}</span></li>`).join('')}</ul>
    <h4>Paragraphs</h4>
    <pre class="mono">${esc((simple.paragraphs||[]).slice(0,50).join('\n\n'))}</pre>
  `;
  $('#raw').textContent = JSON.stringify(raw, null, 2);
}

async function post(url, data){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { throw new Error(`Bad JSON from ${url}: ${txt.slice(0,200)}`); }
}

function esc(s){ return String(s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
