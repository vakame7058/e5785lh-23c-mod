import socket, os, sys, threading
p=sys.argv[1]
try: os.unlink(p)
except OSError: pass
s=socket.socket(socket.AF_UNIX); s.bind(p); s.listen(5)
resp=b'<?xml version="1.0" encoding="UTF-8"?>\n<response>\n<rsrp>-95dBm</rsrp>\n<sinr>13dB</sinr>\n<rssi>&gt;=-51dBm</rssi>\n<rsrq>-9dB</rsrq>\n</response>\n'
while True:
    c,_=s.accept(); c.recv(256); c.sendall(resp); c.close()
