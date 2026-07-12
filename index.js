const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

const landingHTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Прокси-доступ</title>
<style>body{font-family:Arial;max-width:600px;margin:2em auto;padding:1em;background:#f5f5f5;}
input[type="text"]{width:100%;padding:0.8em;font-size:1.2em;}</style>
</head>
<body>
<h2>🔓 Введите адрес сайта</h2>
<form><input type="text" name="url" placeholder="https://docs.google.com/document/d/...">
<button style="margin-top:1em;padding:0.5em 2em;">Открыть</button></form>
<p>Или сразу перейдите по ссылке:<br><code>https://ВАШ_СЕРВЕР/?url=АДРЕС</code></p>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const targetUrl = parsedUrl.query.url;

  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200).end('OK');
    return;
  }

  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(landingHTML.replace('ВАШ_СЕРВЕР', req.headers.host));
    return;
  }

  // WebSocket обрабатываем отдельно (событие upgrade на сервере)
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    // Не обрабатываем здесь, т.к. upgrade идёт на сервер целиком
    res.writeHead(400);
    res.end('WebSocket should be handled by server upgrade event');
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
    // Редиректы
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
      let loc = proxyRes.headers.location;
      if (loc) {
        if (loc.startsWith('http')) loc = `/?url=${encodeURIComponent(loc)}`;
        else if (loc.startsWith('/')) loc = `/?url=${encodeURIComponent(target.protocol + '//' + target.host + loc)}`;
        proxyRes.headers.location = loc;
      }
    }

    const contentType = proxyRes.headers['content-type'] || '';
    const isHTML = contentType.includes('text/html');

    if (!isHTML) {
      // JS, CSS, картинки, шрифты — отдаём как есть
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // HTML: распаковываем и подменяем ссылки
    const encoding = proxyRes.headers['content-encoding'];
    let chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      let buffer = Buffer.concat(chunks);
      const decompress = (buf, enc, cb) => {
        if (!enc) return cb(null, buf);
        const encLower = enc.toLowerCase();
        if (encLower.includes('gzip')) zlib.gunzip(buf, cb);
        else if (encLower.includes('deflate')) zlib.inflate(buf, cb);
        else if (encLower.includes('br')) zlib.brotliDecompress(buf, cb);
        else cb(null, buf);
      };
      decompress(buffer, encoding, (err, decompressed) => {
        if (err) {
          console.error('Decompress error:', err);
          res.writeHead(502).end('Decompress error');
          return;
        }
        let html = decompressed.toString('utf-8');
        // Подменяем ссылки
        html = html.replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi, (_, attr, link) => {
          return `${attr}="/?url=${encodeURIComponent(link)}"`;
        });
        html = html.replace(/(href|src|action)="(\/[^"]*)"/gi, (_, attr, link) => {
          const absUrl = `${target.protocol}//${target.host}${link}`;
          return `${attr}="/?url=${encodeURIComponent(absUrl)}"`;
        });
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['content-encoding'];
        delete responseHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, responseHeaders);
        res.end(html);
      });
    });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err.message);
    res.writeHead(502).end('Proxy error');
  });

  req.pipe(proxyReq);
});

// Обработчик WebSocket на уровне сервера
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const targetUrl = parsedUrl.query.url;
  if (!targetUrl) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const target = url.parse(targetUrl);
  const transport = target.protocol === 'https:' ? https : http;

  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.path,
    method: req.method,
    headers: {
      ...req.headers,
      host: target.hostname,
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
  };

  const proxyReq = transport.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(proxyHead);
    proxySocket.pipe(socket).pipe(proxySocket);
  });
  proxyReq.on('error', (err) => {
    console.error('WebSocket proxy error:', err.message);
    socket.destroy();
  });
  proxyReq.end();
});

server.listen(PORT, () => console.log(`Прокси запущен на порту ${PORT}`));
