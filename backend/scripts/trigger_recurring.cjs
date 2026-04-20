const http = require('http');
const id = 'rec-1776695591667-288a13';
const options = {
  hostname: 'localhost',
  port: 4000,
  path: `/recurring/${id}/trigger`,
  method: 'POST',
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log(body);
  });
});
req.on('error', (err) => {
  console.error('ERROR', err);
});
req.end();
