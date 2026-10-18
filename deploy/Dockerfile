# BU DOSYA BİLEREK KULLANILMAZ — tek gerçek Dockerfile repo kökündedir: ../Dockerfile
#
# Neden: bulut platformları (Back4App, Render, Northflank) Dockerfile'ı KÖKTE arar. İki kopya
# tutmak "biri güncellenir, diğeri unutulur" sürüklenmesi üretirdi. Bu yüzden:
#   - Kök `Dockerfile`            → üretim imajının TEK kaynağı (build context: repo kökü)
#   - `deploy/docker-compose.yml` → kökteki Dockerfile'i kullanır (dockerfile: Dockerfile)
#
# Bu dosyayı build etmeyin; kullanılabilir bir Dockerfile DEĞİLDİR.
#
# (Buradaki eski içerik kök Dockerfile'a taşındı ve PORT düzeltmesi orada yapıldı:
#  platformların verdiği $PORT'a uyum. Ayrıntı: ../Dockerfile başındaki "PORT KURALI" notu.)


