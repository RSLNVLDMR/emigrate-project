const $ = sel => document.querySelector(sel);


setStatus('signing…');
const sign = await post('/api/gcs-sign-upload', {filename: f.name, contentType: f.type});
if (sign.error) return alert(sign.error);


setStatus('uploading…');
await fetch(sign.uploadUrl, { method:'PUT', headers:{'Content-Type': f.type}, body: f });


gsUri = sign.gsUri; objectName = sign.objectName;
$('#meta').textContent = `Uploaded: ${gsUri}`;
$('#start').disabled = false;
setStatus('uploaded');
}


$('#start').onclick = async () => {
if (!gsUri) return;
setStatus('starting OCR…');
const start = await post('/api/docai-start', { gsUris: [gsUri] });
if (start.error) return alert(start.error);
op = start.operationName; outPrefix = start.outputPrefix;
setStatus('processing…');
poll();
}


async function poll(){
const r = await fetch(`/api/docai-status?operationName=${encodeURIComponent(op)}&outputPrefix=${encodeURIComponent(outPrefix)}`).then(r=>r.json());
if (r.done && !r.error){
setStatus('done');
render(r);
} else if (r.error){
setStatus('error'); alert(JSON.stringify(r.error));
} else {
setTimeout(poll, 3000);
}
}


function render(r){
const simple = r.simplified?.[0] || {};
const raw = r.outputs?.[0] || {};
$('#simple').innerHTML = `
<div class="mono">pages: ${simple.pages}</div>
<h4>Key‑Value pairs</h4>
<ul>${(simple.kvPairs||[]).map(kv=>`<li><strong>${esc(kv.key)}</strong>: ${esc(kv.value)} <span class="pill">${(kv.confidence??'').toString().slice(0,5)}</span></li>`).join('')}</ul>
<h4>Entities</h4>
<ul>${(simple.entities||[]).map(e=>`<li>${esc(e.type)} → ${esc(e.mentionText)} <span class="pill">${(e.confidence??'').toString().slice(0,5)}</span></li>`).join('')}</ul>
<h4>Paragraphs</h4>
<pre class="mono">${esc((simple.paragraphs||[]).slice(0,50).join('\n\n'))}</pre>
`;
$('#raw').textContent = JSON.stringify(raw, null, 2);
}


async function post(url, data){
return fetch(url,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}).then(r=>r.json());
}


function esc(s){ return String(s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
