#!/usr/bin/env bash
# AI'A NOT: dev.sh — AstroVector geliştirme yardımcısı.
# NEDEN VAR: Windows/MSYS'te `terminal(background=true)` ile node başlatıldığında wrapper
# anında ölür ('stdin is not a tty') ama gerçek node.exe ARKA PLANDA yaşamaya devam eder.
# Sonuç: "server kapandı" sanırsın, port hâlâ tutulur, bir sonraki başlatma EADDRINUSE verir.
# Bu script doğru başlatma (stdin /dev/null) + port sahibini bulup temizleme işini yapar.
#
# KULLANIM:  ./dev.sh start | stop | status | restart

set -u
PORTS=(8081 8090)
ROOT="$(cd "$(dirname "$0")" && pwd)"

# AI'A NOT: Yalnız YEREL adresinde bu port olan TCP satırları sayılır.
# NEDEN: `grep ":8081"` deseni, bizim sunucuya açtığımız istemci bağlantılarının
# TIME_WAIT satırlarını da yakalar (orada 8081 YABANCI adres kolonundadır ve PID 0'dır).
# Sonuç: sunucu kapalıyken `start` "Port zaten kullanimda (PID: 0)" diyip HİÇ başlamıyor,
# `stop` ise boşuna PID 0'ı öldürmeye çalışıyordu. Ayrica PID 0 (System Idle) filtrelenir.
pids_on_ports() {
  netstat -ano 2>/dev/null | awk -v ports="${PORTS[*]}" '
    BEGIN { n = split(ports, p, " "); for (i = 1; i <= n; i++) want[p[i]] = 1 }
    $1 ~ /^TCP/ {
      split($2, a, ":")
      if (a[length(a)] in want && $NF ~ /^[0-9]+$/ && $NF != 0) print $NF
    }' | sort -u
}

case "${1:-start}" in
  start)
    if [ -n "$(pids_on_ports)" ]; then
      echo "Port zaten kullanimda (PID: $(pids_on_ports | tr '\n' ' ')). Once './dev.sh stop'."
      exit 1
    fi
    # AI'A NOT: `exec ... < /dev/null` — stdin'i bağla ki wrapper hayatta kalsın.
    # AI'A NOT: Script yolunu MUTLAK MSYS yolu ($ROOT = /d/tool projects/...) olarak node'a
    # VERME. Bu ortamda native programlara MSYS yol çevirimi YOK: node bunu `D:\d\tool projects\...`
    # diye çözer ve `MODULE_NOT_FOUND` ile ölür (yani `./dev.sh start` hiç başlamıyordu, üstelik
    # hata "background process exited 1" diye görünüyordu). Çözüm: önce proje köküne cd, sonra
    # GÖRECELİ yol ver — çevrilecek mutlak yol kalmaz.
    cd "$ROOT" || { echo "cd basarisiz: $ROOT"; exit 1; }
    exec node backend/server.js < /dev/null
    ;;
  stop)
    PIDS="$(pids_on_ports)"
    if [ -z "$PIDS" ]; then echo "Portlar zaten bos."; exit 0; fi
    for p in $PIDS; do
      echo "Kill PID $p"
      taskkill /PID "$p" /F >/dev/null 2>&1 || echo "  (kill edilemedi: $p)"
    done
    # AI'A NOT: taskkill ASENKRON çalışır — PID öldürülür ama port birkaç yüz ms daha tutulur ve
    # hemen ardından `start` çağrılırsa "Port zaten kullanimda" deyip GERİ DÖNER (yaşandı:
    # stop → start zinciri sunucuyu hiç başlatmadı, üstelik belirti "server kapalı" gibi göründü).
    # Bu yüzden sabit `sleep 1` yerine port GERÇEKTEN boşalana kadar bekle (en fazla ~6 sn).
    for _ in $(seq 1 12); do
      [ -z "$(pids_on_ports)" ] && break
      sleep 0.5
    done
    [ -z "$(pids_on_ports)" ] && echo "Temiz." || echo "UYARI: portlar hala dolu!"
    ;;
  status)
    PIDS="$(pids_on_ports)"
    if [ -z "$PIDS" ]; then echo "Kapali (portlar bos)."; else
      echo "Calisiyor — PID: $(echo "$PIDS" | tr '\n' ' ')"
      netstat -ano 2>/dev/null | grep -E ":($(IFS='|'; echo "${PORTS[*]}"))[[:space:]]" | head -4
    fi
    ;;
  restart) "$0" stop; "$0" start ;;
  *) echo "Kullanim: $0 {start|stop|status|restart}"; exit 1 ;;
esac