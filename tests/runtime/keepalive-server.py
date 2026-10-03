#!/usr/bin/env python3
"""A keep-alive HTTP server for keepalive.mjs: answers every request with the number of the connection it came on.

Usage: keepalive-server.py PORT [--hint SECONDS] [--silent-after SECONDS]
  --hint N          send `Keep-Alive: timeout=N` with every response
  --silent-after N  a connection idle for N seconds stops answering, without closing: what a NAT that forgot the connection, or
                    a network that went away while the machine slept, looks like from the client"""
import socket
import sys
import threading
import time

port = int(sys.argv[1])
hint = sys.argv[sys.argv.index("--hint") + 1] if "--hint" in sys.argv else ""
silent_after = float(sys.argv[sys.argv.index("--silent-after") + 1]) if "--silent-after" in sys.argv else None
count = 0


def handle(connection, number):
    buffer = b""
    connection.settimeout(silent_after)
    try:
        while True:
            try:
                chunk = connection.recv(65536)
            except socket.timeout:
                time.sleep(3600)
                return
            if not chunk:
                connection.close()
                return
            buffer += chunk
            while b"\r\n\r\n" in buffer:
                head, rest = buffer.split(b"\r\n\r\n", 1)
                length = 0
                for line in head.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":")[1])
                while len(rest) < length:
                    rest += connection.recv(65536)
                buffer = rest[length:]
                body = str(number).encode()
                extra = b"Keep-Alive: timeout=" + hint.encode() + b"\r\n" if hint else b""
                connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: keep-alive\r\n" + extra
                                   + b"Content-Length: %d\r\n\r\n" % len(body) + body)
    except OSError:
        connection.close()


server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(64)
while True:
    connection, _ = server.accept()
    count += 1
    threading.Thread(target=handle, args=(connection, count), daemon=True).start()
