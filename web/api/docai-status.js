import {getDocAiClient, getStorage, env, json} from './_gcp';


export default async function handler(req,res){
try {
const {operationName, outputPrefix} = req.query;
if (!operationName || !outputPrefix) return json(res,400,{error:'operationName and outputPrefix required'});


const client = getDocAiClient();
const [op] = await client.operationsClient.getOperation({name: operationName});


if (!op.done) return json(res,200,{done:false});
if (op.error) return json(res,500,{done:true,error:op.error});


// List output JSONs from GCS
const {bucket} = env();
const storage = getStorage();
const [files] = await storage.bucket(bucket).getFiles({prefix: `${outputPrefix}/`});
const outputs = [];


for (const f of files.filter(f=>f.name.endsWith('.json'))) {
const [buf] = await f.download();
const obj = JSON.parse(buf.toString());
outputs.push(obj);
}


// Flatten documents for UI
const simplified = outputs.map(o => simplifyDoc(o.document || o));


return json(res,200,{done:true, outputs, simplified});
} catch (e) { return json(res,500,{error:e.message}); }
}


function simplifyDoc(doc){
const out = {pages: doc.pages?.length || 0, text: doc.text || '', entities:[], kvPairs:[], paragraphs:[]};
// Entities (if any)
if (doc.entities) out.entities = doc.entities.map(e=>({type:e.type, mentionText:e.mentionText, confidence:e.confidence}));
// Layout paragraphs
for (const p of doc.pages || []){
for (const bl of p.blocks || []){
const paraTexts = (bl.paragraphs||[]).map(par=>layoutText(doc, par.layout));
out.paragraphs.push(...paraTexts.filter(Boolean));
}
// Key-Value Pairs if present (some processors expose form fields)
for (const f of p.formFields || []){
out.kvPairs.push({
key: layoutText(doc, f.fieldName?.layout),
value: layoutText(doc, f.fieldValue?.layout),
confidence: f.fieldValue?.confidence
});
}
}
return out;
}


function layoutText(doc, layout){
if (!layout || !layout.textAnchor) return '';
const segs = layout.textAnchor.textSegments || [];
let s = '';
for (const seg of segs){
const start = parseInt(seg.startIndex || 0, 10);
const end = parseInt(seg.endIndex || 0, 10);
s += (doc.text || '').substring(start, end);
}
return s.trim();
}
