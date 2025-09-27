import {getStorage, env, json} from './_gcp';


export default async function handler(req, res) {
try {
if (req.method !== 'POST') return json(res, 405, {error: 'Method not allowed'});
const {filename, contentType} = req.body || {};
if (!filename || !contentType) return json(res, 400, {error: 'filename and contentType required'});


const {bucket} = env();
const storage = getStorage();
const bucketRef = storage.bucket(bucket);


const objectName = `uploads/${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
const file = bucketRef.file(objectName);


const [url] = await file.getSignedUrl({
version: 'v4',
action: 'write',
expires: Date.now() + 15 * 60 * 1000, // 15 min
contentType,
});


return json(res, 200, {
uploadUrl: url,
gsUri: `gs://${bucket}/${objectName}`,
objectName,
});
} catch (e) { return json(res, 500, {error: e.message}); }
}
