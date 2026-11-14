# Arsitektur (versi singkat)

Detail kebutuhan ada di [PLAN.md](PLAN.md), cara menjalankan di [README.md](README.md).

## 1. Satu gambar

```mermaid
flowchart LR
  C[App Customer] --> W
  D[App Driver] --> W
  W[Worker<br/>pintu masuk API] --> Z[Zone<br/>pengatur per wilayah]
  W --> DB[(Postgres<br/>lewat Hyperdrive)]
  Z --> DB
```

Hanya ada **3 bagian** di server:

| Bagian | Analogi | Tugas |
|---|---|---|
| **Worker** | resepsionis | cek login, terima request, arahkan ke zona yang tepat |
| **Zone** (Durable Object) | dispatcher wilayah | tahu posisi semua driver di wilayahnya, cari driver, kirim tawaran, pantau perjalanan |
| **Postgres** | arsip | simpan user, riwayat ride, saldo & hold wallet; menjamin 1 ride aktif per customer |

## 2. Kenapa dibagi per zona?

Jakarta dibagi jadi kotak-kotak ±5 km (pakai *geohash*). **Tiap kotak punya satu "dispatcher" sendiri** (satu Durable Object).

- Dispatcher bekerja **satu per satu** (tidak paralel di dalam dirinya), jadi satu driver tidak mungkin dapat dua order sekaligus. Tanpa perlu lock.
- Kota makin ramai → kotak diperkecil → dispatcher bertambah. Itu cara scale-nya.
- Posisi driver disimpan **di memori** dispatcher (plus grid kotak kecil untuk cari driver terdekat), bukan ditulis ke storage tiap ping — supaya murah. Snapshot ke storage tiap 30 detik untuk pemulihan.
- ID ride menyimpan nama zonanya (`qqguy_…`), jadi server langsung tahu dispatcher mana yang pegang ride itu.

## 3. Alur satu perjalanan

```mermaid
sequenceDiagram
  participant Cu as Customer
  participant Z as Dispatcher zona
  participant Dr as Driver
  Cu->>Z: Pesan ride (jemput, tujuan, bayar)
  Z->>Z: Cari driver terdekat yang kosong
  Z->>Dr: Tawaran (15 detik)
  Dr->>Z: Terima
  Z-->>Cu: Driver ditemukan
  loop tiap detik
    Dr->>Z: Lokasi
    Z-->>Cu: Lokasi driver
  end
  Dr->>Z: Tiba → Mulai → Selesai
  Z->>Z: Potong saldo / catat tunai
  Z-->>Cu: Selesai + dibayar
```

Kalau driver **menolak atau diam 15 detik**, tawaran pindah ke driver terdekat berikutnya. Kalau tidak ada yang mau dalam 2 menit → "Driver tidak ditemukan".

Status ride:
`REQUESTED → OFFERING → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED` (bisa `CANCELLED` sebelum jemput, atau `NO_DRIVER`).

## 4. Real-time

- App terhubung lewat **WebSocket** ke dispatcher zonanya.
- Saat ride berjalan, **customer dan driver terhubung ke dispatcher yang sama**, jadi lokasi driver langsung diteruskan ke customer.
- Kalau driver menerima order dari zona sebelah, server menyuruh app driver **pindah sambungan** ke zona ride (`zone.moved`). App melakukannya otomatis.
- Koneksi putus → app sambung ulang sendiri (jeda acak, supaya tidak serentak saat deploy) dan minta status terbaru. Sambung ulang tidak menyentuh database.
- Driver kosong yang melewati batas zona baru dipindah setelah ±100 m masuk zona baru atau 3 ping berturut-turut di luar (GPS goyang di garis batas tidak bikin putus-sambung terus).
- Ping lokasi yang terlalu rapat (< 2 dtk) dan hampir tidak bergerak dibuang server; app driver hanya kirim tiap 30 m atau 5 detik.

## 5. Data disimpan di mana?

| Data | Tempat | Alasan |
|---|---|---|
| Posisi driver | memori dispatcher zona | berubah tiap detik, harus cepat & murah |
| Status driver, ride yang sedang jalan, timer | storage dispatcher zona (SQLite) | harus selamat kalau dispatcher restart |
| User, riwayat ride, saldo, transaksi & hold wallet | Postgres | harus permanen & konsisten |

Lokasi driver **tidak** disimpan ke database, karena terlalu sering berubah dan tidak perlu diarsipkan.

## 6. Wallet

- Saat **pesan** pakai wallet: tarif di-*hold* dari saldo (ditolak kalau saldo tersedia kurang). Batal / tidak dapat driver → hold dilepas.
- Saat ride **selesai**: bayar wallet → saldo customer dipotong, driver dapat tarif − komisi 20%. Bayar tunai → driver dipotong komisi.
- Semua langkah dijalankan dalam **satu transaksi**: semua berhasil, atau tidak ada yang berubah.
- Aman diulang: kalau proses pembayaran terpanggil dua kali, saldo **tidak** terpotong dua kali.
- Pengaman terakhir: kalau saldo kurang saat selesai (tanpa hold) → dianggap bayar tunai.

## 7. Kode-nya di mana

```
packages/core       logika murni: cari driver, hitung tarif, status ride, pembagian uang
packages/client     kode bersama untuk app: API, WebSocket, peta, rute jalan
apps/api            server: Worker + dispatcher zona + database
apps/simulator-*    app web customer & driver (untuk demo tanpa HP)
apps/e2e            test otomatis yang menjalankan kedua app (Playwright)
```

## 8. Batasan POC

- Tarif dihitung dari jarak lurus × 1,3, belum jarak jalan sebenarnya.
- Login tanpa OTP. Top-up wallet masih dummy.
- Rute jalan di simulator pakai server OSRM publik, hanya untuk demo.
- Belum ada payment gateway, promo, chat, atau verifikasi driver.

---

**Istilah:**
- *Durable Object*: "mini server" Cloudflare yang punya memori & penyimpanan sendiri dan menangani request satu per satu.
- *Geohash*: cara membagi peta jadi kotak-kotak berkode huruf.
- *Hyperdrive*: layanan Cloudflare yang mem-pool koneksi Worker/Durable Object ke Postgres.
