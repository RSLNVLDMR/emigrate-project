import {GoogleAuth} from 'google-auth-library';
import {Storage} from '@google-cloud/storage';
import {DocumentProcessorServiceClient} from '@google-cloud/documentai';


function getSaCredentials() {
const json = process.env.GCP_SERVICE_ACCOUNT_JSON;
if (!json) throw new Error('GCP_SERVICE_ACCOUNT_JSON is missing');
const creds = JSON.parse(json);
return {
credentials: {
client_email: creds.client_email,
private_key: creds.private_key,
},
projectId: process.env.GCP_PROJECT_ID,
};
}


export function getStorage() {
const {credentials, projectId} = getSaCredentials();
return new Storage({projectId, credentials});
}


export function getDocAiClient() {
const {credentials} = getSaCredentials();
const apiEndpoint = `${process.env.GCP_LOCATION}-documentai.googleapis.com`;
return new DocumentProcessorServiceClient({credentials, apiEndpoint});
}


export function env() {
const e = {
projectId: process.env.GCP_PROJECT_ID,
location: process.env.GCP_LOCATION || 'eu',
processorId: process.env.DOC_AI_PROCESSOR_ID,
bucket: process.env.GCS_BUCKET,
};
for (const [k,v] of Object.entries(e)) if (!v) throw new Error(`Missing env ${k}`);
return e;
}


export function json(res, status, data) {
res.statusCode = status; res.setHeader('Content-Type','application/json');
res.end(JSON.stringify(data));
}
