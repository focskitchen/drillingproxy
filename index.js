const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const targetUrl = parsedUrl.query.url;

  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200).end('OK');
    return;
  }

  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<form><input name="url" placeholder="https://..."><button>Go</button></form>');
    return;
  }

  const target = url.parse(targetUrl);
  const transport = target.protocol === 'https:' ? https : http;

  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.path,
    method: req.method,
    headers: { ...req.headers, host: target.hostname },
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502).end('Proxy error');
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => console.log('Proxy on', PORT));
