const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

// Страница-приветствие
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

  // Health check для Render
  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(landingHTML.replace('ВАШ_СЕРВЕР', req.headers.host));
    return;
  }

  // Обработка WebSocket (Telegram чаты)
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWebSocket(req, res, targetUrl);
    return;
  }

  const target = url.parse(targetUrl);
  if (!target.protocol || !['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400);
    res.end('Некорректный URL');
    return;
  }

  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.path,
    method: req.method,
    headers: { ...req.headers, host: target.hostname },
  };

  const transport = target.protocol === 'https:' ? https : http;

  const proxyReq = transport.request(options, (proxyRes) => {
    // Редиректы переписываем
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
      const location = proxyRes.headers.location;
      if (location) {
        let newLocation;
        if (location.startsWith('http')) {
          newLocation = `/?url=${encodeURIComponent(location)}`;
        } else if (location.startsWith('/')) {
          newLocation = `/?url=${encodeURIComponent(target.protocol + '//' + target.host + location)}`;
        } else {
          newLocation = location;
        }
        proxyRes.headers.location = newLocation;
      }
    }

    // Определяем, сжато ли тело
    const encoding = proxyRes.headers['content-encoding'];
    let chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      let buffer = Buffer.concat(chunks);

      // Функция для распаковки
      const decompress = (buf, enc, cb) => {
        if (!enc) return cb(null, buf);
        const encLower = enc.toLowerCase();
        if (encLower.includes('gzip')) {
          zlib.gunzip(buf, cb);
        } else if (encLower.includes('deflate')) {
          zlib.inflate(buf, cb);
        } else if (encLower.includes('br')) {
          zlib.brotliDecompress(buf, cb);
        } else {
          cb(null, buf); // неизвестный, оставляем как есть
        }
      };

      decompress(buffer, encoding, (err, decompressed) => {
        if (err) {
          res.writeHead(502);
          res.end('Ошибка распаковки');
          return;
        }
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['transfer-encoding'];
        // Убираем сжатие, т.к. отдаём уже распакованное
        delete responseHeaders['content-encoding'];

        const contentType = responseHeaders['content-type'] || '';
        let bodyStr = decompressed.toString('utf-8');

        // Подменяем ссылки в HTML/JS/CSS
        if (contentType.includes('text/html') || contentType.includes('application/javascript') || contentType.includes('text/css')) {
          bodyStr = bodyStr.replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi, (match, attr, link) => {
            return `${attr}="/?url=${encodeURIComponent(link)}"`;
          });
          bodyStr = bodyStr.replace(/(href|src|action)="(\/[^"]*)"/gi, (match, attr, link) => {
            const absUrl = `${target.protocol}//${target.host}${link}`;
            return `${attr}="/?url=${encodeURIComponent(absUrl)}"`;
          });
        }

        res.writeHead(proxyRes.statusCode, responseHeaders);
        res.end(bodyStr);
      });
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Прокси-ошибка: ' + err.message);
  });

  if (req.method === 'POST' || req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => proxyReq.end(body));
  } else {
    proxyReq.end();
  }
});

// WebSocket прокси (упрощённый, без сжатия)
function handleWebSocket(req, socket, head, targetUrlStr) {
  const target = url.parse(targetUrlStr);
  const proxyReq = (target.protocol === 'https:' ? https : http).request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.path,
    method: 'GET',
    headers: {
      ...req.headers,
      host: target.hostname,
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(proxyHead);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    socket.end();
  });

  proxyReq.end();
}

server.listen(PORT, () => {
  console.log(`Прокси запущен на порту ${PORT}`);
});
