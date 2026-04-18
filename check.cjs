const http = require('http');
http.get('http://0.0.0.0:3000/api/debug-state', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});
