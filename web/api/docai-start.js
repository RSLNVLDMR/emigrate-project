import {getDocAiClient, env, json} from './_gcp';


export default async function handler(req,res){
try {
if (req.method !== 'POST') return json(res,405,{error:'Method not allowed'});
const {gsUris} = req.body || {}; // array of gs:// paths
if (!Array.isArray(gsUris) || gsUris.length===0) return json(res,400,{error:'gsUris[] required'});


const {projectId, location, processorId, bucket} = env();
const client = getDocAiClient();


// Output prefix per batch
const outPrefix = `docai_out/${Date.now()}`;


const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
const request = {
name,
inputDocuments: {
gcsDocuments: {
documents: gsUris.map(u => ({gcsUri: u, mimeType: u.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*'}))
}
},
documentOutputConfig: {
gcsOutputConfig: { gcsUri: `gs://${bucket}/${outPrefix}/` }
}
};


const [operation] = await client.batchProcessDocuments(request);
return json(res,200,{ operationName: operation.name, outputPrefix: outPrefix });
} catch (e) { return json(res,500,{error:e.message}); }
}
