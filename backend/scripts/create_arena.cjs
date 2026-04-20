const http = require('http');
const data = JSON.stringify({ entryFeeWei: '5000000', durationSeconds: 86400, settlementTokenSymbol: 'USDC', title: 'Daily Trading Competition (manual)', game: 'Trading', metric: 'PnL' });

const options = {
  hostname: 'localhost',
  port: 4000,
  path: '/arena',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
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
req.write(data);
req.end();
