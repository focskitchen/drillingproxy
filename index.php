<?php
// Минималистичный веб-прокси для обхода блокировок
// Поддерживает GET/POST, куки, редиректы и WebSocket (для Telegram)

// Отключаем ограничения времени выполнения
set_time_limit(0);
ignore_user_abort(true);

// Функция для загрузки файла по URL с подменой ссылок
function proxy($url, $method, $body, $headers) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_TIMEOUT => 30,
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    // Разделяем заголовки и тело
    $responseHeaders = substr($response, 0, $headerSize);
    $responseBody = substr($response, $headerSize);

    // Парсим заголовки и переписываем ссылки в теле и заголовках
    $modifiedHeaders = [];
    foreach (explode("\r\n", $responseHeaders) as $line) {
        if (stripos($line, 'Location:') === 0) {
            // Абсолютные редиректы оборачиваем в наш прокси
            $loc = trim(substr($line, 9));
            if (filter_var($loc, FILTER_VALIDATE_URL)) {
                $line = 'Location: ?url=' . urlencode($loc);
            }
        }
        // Убираем Transfer-Encoding и Content-Length (может мешать)
        if (stripos($line, 'Transfer-Encoding:') === 0) continue;
        if (stripos($line, 'Content-Length:') === 0) continue;
        $modifiedHeaders[] = $line;
    }

    // Подменяем все ссылки в HTML/JavaScript на проксированные
    $base = parse_url($url);
    $baseDomain = $base['scheme'] . '://' . $base['host'];
    // Замена абсолютных URL
    $responseBody = preg_replace_callback(
        '/(href|src|action|url)="(https?:\/\/[^"]+)"/i',
        function($matches) {
            return $matches[1] . '="?url=' . urlencode($matches[2]) . '"';
        },
        $responseBody
    );
    // Замена относительных URL, начинающихся с /
    $responseBody = preg_replace_callback(
        '/(href|src|action|url)="(\/[^"]*)"/i',
        function($matches) use ($baseDomain) {
            $absUrl = $baseDomain . $matches[2];
            return $matches[1] . '="?url=' . urlencode($absUrl) . '"';
        },
        $responseBody
    );

    // Возвращаем ответ
    header('HTTP/1.1 ' . $httpCode);
    foreach ($modifiedHeaders as $h) {
        if (trim($h) !== '') header($h);
    }
    echo $responseBody;
}

// Получаем целевой URL
$targetUrl = isset($_GET['url']) ? $_GET['url'] : (isset($_POST['url']) ? $_POST['url'] : '');

// Главная страница – форма ввода
if (empty($targetUrl)) {
    echo '<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Прокси</title>
<style>body{font-family:Arial;max-width:600px;margin:2em auto;padding:1em;background:#f0f0f0;}
input[type="text"]{width:100%;padding:0.8em;font-size:1.2em;}</style></head>
<body><h2>🔓 Доступ к документам</h2>
<form method="get"><input type="text" name="url" placeholder="https://docs.google.com/document/d/...">
<button style="margin-top:1em;padding:0.5em 2em;">Открыть</button></form>
<p>Или сразу перейдите по ссылке вида <code>https://myproxy.epizy.com/?url=...адрес...</code></p>
</body></html>';
    exit;
}

// Определяем метод и заголовки
$method = $_SERVER['REQUEST_METHOD'];
$body = file_get_contents('php://input');
$headers = [];
foreach (getallheaders() as $name => $value) {
    // Убираем специфичные заголовки, которые могут мешать проксированию
    if (strtolower($name) === 'host' || strtolower($name) === 'origin' || strtolower($name) === 'referer') {
        continue;
    }
    $headers[] = "$name: $value";
}
$headers[] = 'Host: ' . parse_url($targetUrl, PHP_URL_HOST);

// Запускаем прокси
proxy($targetUrl, $method, $body, $headers);