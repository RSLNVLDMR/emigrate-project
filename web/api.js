/* M1 mock API (localStorage). In M2 we'll swap to Vercel Functions. */

import { storage } from './utils.js';

export function saveQuestionnaire(data){
  storage.set('questionnaire', data);
}
export function getQuestionnaire(){
  return storage.get('questionnaire',{});
}

export function saveChecklist(pathId, items){
  storage.set('checklist_'+pathId, items);
}
export function getChecklist(pathId){
  return storage.get('checklist_'+pathId, null);
}

export async function translateText({text, from='ru', to='pl'}){
  // M1 stub
  return `DEMO (${from}→${to}): ${text}`;
}

export async function createConsultDraft({topic, message}){
  const id = 'c'+Date.now();
  storage.set(id, {topic, message});
  return {id};
}
