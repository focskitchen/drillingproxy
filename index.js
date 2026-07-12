const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Простая страница-приветствие, если зашли без параметров
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

  // Endpoint для проверки здоровья (Render Health Check)
  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // Если нет параметра url — показываем форму
  if (!targetUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(landingHTML.replace('ВАШ_СЕРВЕР', req.headers.host));
    return;
  }

  // Обрабатываем WebSocket (Telegram)
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    handleWebSocket(req, res, targetUrl);
    return;
  }

  // Парсим целевой URL
  const target = url.parse(targetUrl);
  if (!target.protocol || !['http:', 'https:'].includes(target.protocol)) {
    res.writeHead(400);
    res.end('Некорректный URL');
    return;
  }

  // Формируем запрос к целевому серверу
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
          newLocation = location; // браузер сам разрулит
        }
        proxyRes.headers.location = newLocation;
      }
    }

    // Копируем заголовки, удаляем лишние
    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['content-encoding']; // чтобы не испортить тело
    res.writeHead(proxyRes.statusCode, responseHeaders);

    // Если HTML или JavaScript — подменяем ссылки
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const contentType = responseHeaders['content-type'] || '';
      if (contentType.includes('text/html') || contentType.includes('application/javascript') || contentType.includes('text/css')) {
        // Заменяем абсолютные URL
        body = body.replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi, (match, attr, link) => {
          return `${attr}="/?url=${encodeURIComponent(link)}"`;
        });
        // Заменяем относительные URL, начинающиеся с /
        body = body.replace(/(href|src|action)="(\/[^"]*)"/gi, (match, attr, link) => {
          const absUrl = `${target.protocol}//${target.host}${link}`;
          return `${attr}="/?url=${encodeURIComponent(absUrl)}"`;
        });
      }
      res.end(body);
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Прокси-ошибка: ' + err.message);
  });

  // Пересылаем тело POST/PUT запросов
  if (req.method === 'POST' || req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => proxyReq.end(body));
  } else {
    proxyReq.end();
  }
});

// Обработка WebSocket
function handleWebSocket(clientReq, clientSocket, head, targetUrlStr) {
  const target = url.parse(targetUrlStr);
  const wsUrl = `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}${target.path}`;
  const proxyReq = (target.protocol === 'https:' ? https : http).request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.path,
    method: 'GET',
    headers: {
      ...clientReq.headers,
      host: target.hostname,
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    proxySocket.write(proxyHead);
    clientSocket.write(proxyHead);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    clientSocket.end();
  });

  proxyReq.end();
}

server.listen(PORT, () => {
  console.log(`Прокси запущен на порту ${PORT}`);
});