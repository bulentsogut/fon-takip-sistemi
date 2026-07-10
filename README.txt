ORKA v23 Ekofin fiyat + günlük oran düzeltmesi

Yüklenecek dosyalar:
- index.html
- api/ekofin.js

Dokunulmayanlar:
- api/yahoo.js
- api/tefas.js
- api/fvt.js
- Fon ağırlık okuma mantığı korunmuştur.

Test:
/api/ekofin?code=TLY&mode=info&debug=1 içinde dailyReturn 0.27 gibi gelmeli.
Fon Verilerini Güncelle butonu sonrası kartta fiyat ve günlük oran görünmeli.
