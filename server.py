"""Local-only screenshot OCR and static demo server. No third-party packages."""
import argparse
import base64
import binascii
import json
import platform
import re
import subprocess
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OCR_LIMIT = threading.BoundedSemaphore(2)


def interpret(lines):
    """Conservative rules over actually recognized text; never execute image instructions."""
    text = '\n'.join(item['text'] for item in lines)[:10000]
    text = re.sub(r'(?i)((?:password|token|secret|api[_ -]?key|密码|密钥)\s*[:=：]\s*)\S+', r'\1[已隐藏]', text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{10,}', '[已隐藏密钥]', text)
    rules = [
        ('security', r'勒索|ransomware|账号被盗|account compromised|可疑登录'),
        ('vpn', r'\bVPN\b|Qiyun\s*Connect|GlobalProtect|AnyConnect|FortiClient'),
        ('network', r'ERR_(?:INTERNET|NETWORK|CONNECTION|NAME)_\w+|DNS_PROBE_\w+|Wi-?Fi|无网络|无法连接网络|网络连接|no internet'),
        ('permission', r'access denied|permission denied|权限不足|拒绝访问|没有权限|403 forbidden'),
        ('software', r'application error|应用程序错误|安装失败|installation failed|crash|应用.*崩溃'),
    ]
    category = next((name for name, pattern in rules if re.search(pattern, text, re.I)), 'unknown')
    environment = re.search(r'Windows\s*(?:10|11)?|macOS(?:\s*\d+(?:\.\d+)*)?', text, re.I)
    # finditer keeps full error-code matches, including prefixed decimal codes.
    codes = list(dict.fromkeys(m.group(0) for m in re.finditer(r'\b(?:0x[0-9a-fA-F]{4,}|ERR_[A-Z_]+|DNS_PROBE_[A-Z_]+)\b|(?:错误码|error\s*code)\s*[:：]?\s*[A-Za-z0-9_-]+', text, re.I)))[:8]
    return {'text': text, 'category': category, 'environment': environment.group(0) if environment else '',
            'errorCodes': codes, 'engine': 'local-ocr', 'hasText': bool(text.strip())}


class Handler(SimpleHTTPRequestHandler):
    ocr_binary = None

    def allowed_origin(self):
        origin = self.headers.get('Origin')
        return origin is None or origin == 'null' or bool(re.fullmatch(r'http://(?:localhost|127\.0\.0\.1):(?:4173|4174)', origin))

    def end_headers(self):
        if self.allowed_origin() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(200 if self.allowed_origin() else 403, {})

    def do_GET(self):
        if self.path == '/api/health':
            return self.reply(200, {'ocr': bool(self.ocr_binary), 'engine': 'local-ocr'})
        if self.path.split('?')[0] not in ('/', '/index.html', '/styles.css', '/app.js', '/screenshots.js'):
            return self.reply(404, {'error': 'Not found'})
        super().do_GET()

    def do_POST(self):
        if not self.allowed_origin():
            return self.reply(403, {'error': '仅允许本地 Demo 调用'})
        if self.path != '/api/analyze-image':
            return self.reply(404, {'error': 'Not found'})
        if not self.ocr_binary:
            return self.reply(503, {'error': '本地截图识别需要 macOS 和 Xcode Command Line Tools；请改用文字描述。'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8_000_000:
                return self.reply(413, {'error': '图片过大，请上传 5MB 以内的截图'})
            body = json.loads(self.rfile.read(length))
            url = body.get('image', '')
            if not isinstance(url, str) or not re.match(r'^data:image/(png|jpeg|webp);base64,', url):
                return self.reply(400, {'error': '仅支持 PNG、JPEG、WebP 图片'})
            image = base64.b64decode(url.split(',', 1)[1], validate=True)
            if len(image) > 5 * 1024 * 1024:
                return self.reply(413, {'error': '图片过大，请压缩后重试'})
            if not OCR_LIMIT.acquire(blocking=False):
                return self.reply(429, {'error': '识别服务繁忙，请稍后重试'})
            try:
                process = subprocess.run([self.ocr_binary], input=image, capture_output=True, timeout=30)
            finally:
                OCR_LIMIT.release()
            result = json.loads(process.stdout)
            if process.returncode or 'error' in result:
                return self.reply(422, {'error': '无法读取这张图片，请重新截取清晰的错误提示。'})
            self.reply(200, interpret(result.get('lines', [])))
        except (ValueError, TypeError, AttributeError, binascii.Error):
            self.reply(400, {'error': '图片数据无效，请重新上传'})
        except subprocess.TimeoutExpired:
            self.reply(504, {'error': '截图识别超时，请重试或直接描述错误提示'})
        except Exception:
            self.reply(503, {'error': '截图识别服务暂不可用，请重试或转人工'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4174)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='xiaoqi-ocr-') as build:
        if platform.system() == 'Darwin':
            print('正在准备本地截图识别…', flush=True)
            binary = str(Path(build) / 'recognize')
            try:
                subprocess.run(['swiftc', '-module-cache-path', str(Path(build) / 'cache'), str(ROOT / 'recognize.swift'), '-o', binary], check=True, timeout=120, capture_output=True)
                Handler.ocr_binary = binary
            except (OSError, subprocess.SubprocessError):
                print('截图识别未启动。需要 macOS 的 Xcode Command Line Tools；文字流程仍可使用。', flush=True)
        server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
        print(f'Demo: http://localhost:{args.port} · 本地 OCR: {bool(Handler.ocr_binary)}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
