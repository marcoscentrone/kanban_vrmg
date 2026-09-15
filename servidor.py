"""Servidor HTTP local para desenvolvimento do Quadro de Fluxo.

Igual ao `python -m http.server`, mas manda o navegador NAO guardar cache.
Sem isso, ao editar kanban.css ou kanban.js o navegador continua usando a
versao antiga do arquivo e parece que a alteracao "nao pegou".

Uso:  python servidor.py          (porta 5500)
      python servidor.py 8080     (outra porta)
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORTA = int(sys.argv[1]) if len(sys.argv) > 1 else 5500


class SemCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Ignora o If-Modified-Since do navegador: sempre responde 200 com o
    # conteudo atual, nunca 304 "nao mudou".
    def send_head(self):
        self.headers.replace_header("If-Modified-Since", "") if "If-Modified-Since" in self.headers else None
        if "If-None-Match" in self.headers:
            del self.headers["If-None-Match"]
        return super().send_head()

    def log_message(self, fmt, *args):
        # Log enxuto: so o metodo, o caminho e o status.
        sys.stderr.write("  %s\n" % (fmt % args))


if __name__ == "__main__":
    print("")
    print("  Quadro de Fluxo - servidor local (sem cache)")
    print("  http://localhost:%d" % PORTA)
    print("  Ctrl+C para parar")
    print("")
    ThreadingHTTPServer(("127.0.0.1", PORTA), SemCacheHandler).serve_forever()
