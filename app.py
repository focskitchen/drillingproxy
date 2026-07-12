from flask import Flask, request, Response
import requests

app = Flask(__name__)

@app.route("/")
def home():
    return """
    <h2>Simple Web Proxy</h2>
    Использование:
    /proxy?url=https://example.com
    """

@app.route("/proxy")
def proxy():
    target = request.args.get("url")

    if not target:
        return "Параметр url обязателен", 400

    try:
        r = requests.get(
            target,
            headers={
                "User-Agent": request.headers.get(
                    "User-Agent",
                    "Mozilla/5.0"
                )
            },
            timeout=10
        )

        excluded_headers = [
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "connection"
        ]

        headers = [
            (name, value)
            for (name, value) in r.raw.headers.items()
            if name.lower() not in excluded_headers
        ]

        return Response(
            r.content,
            r.status_code,
            headers
        )

    except Exception as e:
        return str(e), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)