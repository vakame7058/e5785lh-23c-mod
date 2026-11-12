#!/bin/sh
# sandbox.sh <install> <каталог_песочницы> - копия install.sh/rollback.sh с путями в песочнице (для теста на ПК)
I=$1; T=$2
mkdir -p $T/pkg $T/tmp $T/online
cp -r $I/files $T/pkg/; sed "s|/app/|$T/app/|g" $I/MANIFEST > $T/pkg/MANIFEST
echo "/dev/block/mtdblock24 $T/app yaffs2 ro 0 0" > $T/mounts
for s in install rollback; do
python3 -I - $I/$s.sh $T/pkg/$s.sh $T <<'PYEOF'
import sys
src,dst,T=sys.argv[1:4]
s=open(src).read()
reps=[('BB=/system/bin/busyboxx','BB=/usr/bin/busybox'),('APP=/app','APP='+T+'/app'),('/online',T+'/online'),('/proc/mounts',T+'/mounts'),
('$BB mount -o remount,rw $APPDEV $APP','true'),("$BB mount -o remount,ro '\"$APPDEV $APP\"",'true\''),('TMP=/tmp/hij_install','TMP='+T+'/tmp/hij_install')]
for a,b in reps:
    if a not in s and 'mount' in a: raise SystemExit('нет шаблона: '+a)
    s=s.replace(a,b)
open(dst,'w').write(s)
PYEOF
done
