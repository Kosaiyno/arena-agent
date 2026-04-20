const http = require('http');
const data = JSON.stringify({
  title: 'Daily Trading Midnight',
  cron: 'midnight-utc',
  entryFeeWei: '5000000',
  durationSeconds: 86400,
  settlementTokenSymbol: 'USDC',
  game: 'Trading',
  metric: 'PnL'
});

const options = {
  hostname: 'localhost',
  port: 4000,
  path: '/recurring',
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
