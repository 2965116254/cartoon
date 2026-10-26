#!/usr/bin/env python3
"""喵呜动漫本地预览服务（no-cache + 跨域代理）

/proxy?url=xxx  —— 通用转发代理：
  1. 解决浏览器 CORS：外部接口与 m3u8 一律经它转发；
  2. m3u8 内容自动重写（子播放列表/分片/KEY 的地址改写为再走代理），
     hls.js 无需任何配置即可播放。
"""
import http.server
import socketserver
import os
import re
import urllib.request
import urllib.parse

PORT = 8081
os.chdir(os.path.dirname(os.path.abspath(__file__)))

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')

# 强制直连：不读系统代理环境变量（Clash 等），避免转发被带偏
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def proxy_url(u: str) -> str:
    return '/proxy?url=' + urllib.parse.quote(u, safe='')


def rewrite_m3u8(text: str, base_url: str) -> str:
    """把 m3u8 里的相对/绝对地址全部改写为走本地代理"""
    out = []

    def repl_uri(m):
        u = urllib.parse.urljoin(base_url, m.group(1))
        return 'URI="' + proxy_url(u) + '"'

    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append('')
        elif s.startswith('#'):
            s = re.sub(r'URI="([^"]+)"', repl_uri, s)
            out.append(s)
        else:
            out.append(proxy_url(urllib.parse.urljoin(base_url, s)))
    return '\n'.join(out)


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/proxy':
            qs = urllib.parse.parse_qs(parsed.query)
            url = qs.get('url', [''])[0]
            if not url.startswith(('http://', 'https://')):
                self.send_error(400, 'bad url')
                return
            # parse_qs 已把 %XX 解码回中文，重新编码为合法 ASCII URL
            url = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%")
            return self.proxy_get(url)
        super().do_GET()

    def proxy_get(self, url):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Accept': '*/*',
                'Referer': url,
            })
            with _opener.open(req, timeout=20) as r:
                data = r.read()
                ctype = r.headers.get('Content-Type', '') or ''
                final_url = r.geturl()
        except Exception as e:  # noqa: BLE001
            self.send_error(502, 'proxy fail: %s' % e)
            return

        is_m3u8 = ('.m3u8' in final_url) or ('mpegurl' in ctype.lower())
        if is_m3u8:
            try:
                data = rewrite_m3u8(data.decode('utf-8', 'replace'), final_url).encode('utf-8')
                ctype = 'application/vnd.apple.mpegurl'
            except Exception:
                pass

        self.send_response(200)
        self.send_header('Content-Type', ctype or 'application/octet-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        print('[喵呜动漫] %s' % (fmt % args))


if __name__ == '__main__':
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print(f'🌸 喵呜动漫已启动： http://127.0.0.1:{PORT}  (Ctrl+C 停止)')
        print(f'🔗 跨域代理已就绪： http://127.0.0.1:{PORT}/proxy?url=<远程地址>')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n拜拜喵～')
