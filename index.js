const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

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

  // WebSocket оставляем на upgrade
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    res.writeHead(400);
    res.end('WebSocket handled separately');
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
    const statusCode = proxyRes.statusCode;
    const headers = { ...proxyRes.headers };

    // Редиректы
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      let loc = headers.location;
      if (loc) {
        if (loc.startsWith('http')) loc = `/?url=${encodeURIComponent(loc)}`;
        else if (loc.startsWith('/')) loc = `/?url=${encodeURIComponent(target.protocol + '//' + target.host + loc)}`;
        headers.location = loc;
      }
      res.writeHead(statusCode, headers);
      res.end();
      return;
    }

    const encoding = headers['content-encoding'];
    const contentType = headers['content-type'] || '';

    // Собираем тело ответа
    const chunks = [];
    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const buffer = Buffer.concat(chunks);

      // Распаковка
      const decompress = (buf, enc, cb) => {
        if (!enc) return cb(null, buf);
        const encLower = enc.toLowerCase();
        if (encLower.includes('gzip')) zlib.gunzip(buf, cb);
        else if (encLower.includes('deflate')) zlib.inflate(buf, cb);
        else if (encLower.includes('br')) zlib.brotliDecompress(buf, cb);
        else cb(null, buf);
      };

      decompress(buffer, encoding, (err, data) => {
        if (err) {
          console.error('Decompress error:', err.message);
          res.writeHead(502);
          return res.end('Decompress error');
        }

        // Если HTML – подменяем ссылки
        if (contentType.includes('text/html')) {
          let html = data.toString('utf-8');
          html = html.replace(/(href|src|action)="(https?:\/\/[^"]+)"/gi, (_, attr, link) => {
            return `${attr}="/?url=${encodeURIComponent(link)}"`;
          });
          html = html.replace(/(href|src|action)="(\/[^"]*)"/gi, (_, attr, link) => {
            const absUrl = `${target.protocol}//${target.host}${link}`;
            return `${attr}="/?url=${encodeURIComponent(absUrl)}"`;
          });
          data = Buffer.from(html, 'utf-8');
        }

        // Убираем сжатие и устанавливаем корректную длину
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = data.length;

        res.writeHead(statusCode, headers);
        res.end(data);
      });
    });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502).end('Proxy error');
  });

  req.pipe(proxyReq);
});

// WebSocket upgrade
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
    console.error('WS proxy error:', err.message);
    socket.destroy();
  });
  proxyReq.end();
});

server.listen(PORT, () => console.log('Proxy running on port', PORT));
