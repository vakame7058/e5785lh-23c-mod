#!/bin/bash
# Сборка amneziawg.ko под ядро Huawei E5785Lh-23c (Balong V7R22, 3.10.100+).
# Нужно: дерево ядра из E5885Ls-93a_open_src (kernel_3.10.100.tar.gz), тулчейн AOSP arm-eabi-4.7
# (коммит 8b880805), конфиг роутера (/proc/config.gz), исходники v3.1.20260906 и патч отсюда.
# Использование: build.sh КАТАЛОГ_ЯДРА КАТАЛОГ_СБОРКИ КАТАЛОГ_ТУЛЧЕЙНА КОНФИГ КАТАЛОГ_МОДУЛЯ
set -e
S=$1 O=$2 TC=$3 CFG=$4 M=$5
export PATH=$TC/bin:$PATH
MK="make -C $S ARCH=arm CROSS_COMPILE=arm-eabi- O=$O LOCALVERSION=+"
mkdir -p "$O"; cp "$CFG" "$O/.config"
$MK HOSTCFLAGS="-Wall -Wmissing-prototypes -Wstrict-prototypes -O2 -fomit-frame-pointer -fcommon" olddefconfig
$MK HOSTCFLAGS="-Wall -Wmissing-prototypes -Wstrict-prototypes -O2 -fomit-frame-pointer -fcommon" -j4 modules_prepare
$MK M="$M" WIREGUARD_VERSION=3.1.20260906 -j4 modules
arm-eabi-strip --strip-debug "$M/amneziawg.ko"
