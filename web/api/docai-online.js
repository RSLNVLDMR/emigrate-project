import {getDocAiClient, env, json} from './_gcp';


export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };


export default async function handler(req,res){
try {
if (req.method !== 'POST') return json(res,405,{error:'Method not allowed'});
const {base64, mimeType} = req.body || {};
if (!base64 || !mimeType) return json(res,400,{error:'base64 & mimeType required'});


const {projectId, location, processorId} = env();
const client = getDocAiClient();
const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;


const rawDocument = {content: base64, mimeType};
const request = { name, rawDocument };


const [result] = await client.processDocument(request);
return json(res,200,{document: result.document});
} catch (e) { return json(res,500,{error:e.message}); }
}
