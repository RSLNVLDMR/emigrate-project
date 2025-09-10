// Очередь отключена — статус-эндпойнт оставлен как заглушка на время, чтобы фронт не падал.
// Можно смело удалить файл, если UI больше не вызывает /api/job-status.

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({
    status: 'unsupported',
    message: 'Queue disabled: document checks run immediately now.'
  }));
}
