# Review Arsitektur — fokus logic ride-hailing (MVP)

Tanggal: 2026-11-14 · Branch: `feat/cloudflare-backend`

Review ini dibuat dengan **membaca kode** (`apps/api/src`, `packages/core`). Tidak ada test atau
simulasi yang dijalankan, jadi setiap temuan di bawah adalah hasil baca kode, bukan hasil percobaan.

## Kesimpulan singkat

Fondasinya kuat. Bagian yang biasanya paling sulit (rebutan driver, uang tidak dobel, data tidak
hilang saat database mati) sudah ditangani dengan baik.

Yang masih kurang justru di **alur perjalanan sehari-hari**:

1. Ride bisa **macet selamanya** kalau driver menghilang saat perjalanan (`ON_TRIP`).
2. Pencarian driver **menyerah setelah ±5 detik** kalau sedang tidak ada driver.
3. Driver bisa menekan Tiba / Mulai / Selesai **dari lokasi mana saja**.

Saran utama: berhenti menambah infrastruktur (TODO Tahap 3–5), kerjakan tiga hal di atas dulu.

---

## 1. Cara kerja sekarang (versi sederhana)

Ada tiga bagian:

| Bagian | File | Tugas |
|---|---|---|
| Worker | `apps/api/src/index.ts` | Pintu masuk. Cek login, lalu meneruskan permintaan ke zona yang tepat. |
| ZoneDO | `apps/api/src/zone.ts` | "Petugas" satu wilayah (±5 km). Memegang posisi driver, mencari driver, mengatur status ride, mengirim pesan WebSocket. |
| Postgres | `apps/api/src/db.ts` | Buku besar. Menyimpan user, riwayat ride, saldo, dan transaksi. |

Alur satu perjalanan:

```
Customer pesan
  → Postgres mencatat ride (+ menahan saldo kalau bayar WALLET)
  → ZoneDO mencari driver terdekat, menawari SATU driver per kali (15 detik)
  → Driver terima  → ACCEPTED
  → Driver tiba    → ARRIVED
  → Driver mulai   → ON_TRIP
  → Driver selesai → COMPLETED → pembayaran diproses di Postgres
```

Status ride: `REQUESTED → OFFERING → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED`,
atau berakhir di `CANCELLED` / `NO_DRIVER`.

---

## 2. Yang sudah bagus (jangan diubah)

- **Aturan status ride terpisah dan murni** (`packages/core/src/rideStateMachine.ts`). Mudah dibaca, mudah dites, event dobel aman.
- **Satu driver tidak bisa direbut dua ride.** `reserveAndOffer` (`zone.ts:577`) dijalankan oleh satu petugas zona, jadi tidak ada balapan.
- **Satu customer hanya punya satu ride aktif**, dijaga langsung oleh Postgres (index `one_active_ride`), jadi aman walau pesan dari dua zona sekaligus.
- **Uang aman.** Saldo ditahan saat pesan, dipotong saat selesai, dikembalikan saat batal. Pembayaran tidak bisa dobel (`settleRide`, `db.ts:300`).
- **Tahan database mati.** Perubahan ride antre dulu di outbox lalu dicoba ulang (`zone.ts:387`); pembayaran dan pembuatan ride juga punya jalur coba-ulang. (Catatan: outbox bisa yatim kalau DO mati saat flush, lihat §3.8.)
- **Test cukup lengkap** untuk alur normal dan kasus rebutan.

---

## 3. Temuan — urut dari yang paling penting

### P1 — Kerjakan sebelum MVP dipakai orang

#### 3.1 Ride bisa macet selamanya saat `ON_TRIP`

**Masalah.** Setelah status `ACCEPTED`, tidak ada batas waktu apa pun. Saat `ACCEPTED` / `ARRIVED`
customer masih bisa membatalkan sendiri, jadi masalah sebenarnya ada di `ON_TRIP`. Kalau HP driver mati saat itu:

- Customer **tidak bisa membatalkan** (`rideStateMachine.ts:19-23`: customer, driver, dan `system` hanya boleh batal sampai `ARRIVED`).
- Ride tetap "aktif" → customer **tidak bisa pesan lagi** (terblokir `one_active_ride`).
- Kalau bayar WALLET, saldo customer **tertahan terus**.
- Saat socket driver putus, sistem tidak melakukan apa-apa (`zone.ts:1105`).

Tidak ada tombol admin untuk membereskan ride seperti ini.

**Saran.**
- Tambah timer penjaga per ride: driver tanpa ping > 5 menit saat `ON_TRIP` → tandai bermasalah / akhiri oleh `system`. (Timer `ACCEPTED` > 15 menit tanpa `ARRIVED` juga berguna, tapi kurang mendesak karena customer masih bisa batal sendiri.)
- Mengakhiri ride `ON_TRIP` butuh aturan baru di state machine: `CANCELLABLE_BY.system` sekarang tidak memuat `ON_TRIP`. Putuskan juga nasib saldo tertahan (dilepas penuh, ditarik sebagian, atau ditarik penuh).
- Sediakan satu endpoint admin "paksa batal / paksa selesai". Belum ada peran admin (`Role` hanya `customer | driver`), jadi tentukan dulu cara autentikasinya.
- Timer-nya sudah ada mekanismenya (tabel `timers`), tinggal tambah jenis baru.

#### 3.2 Pencarian driver menyerah terlalu cepat

**Masalah.** Kalau pencarian pertama kosong, sistem menunggu 5 detik, mencari sekali lagi, lalu langsung `NO_DRIVER` (`zone.ts:737-743`). Padahal batas pencarian di config 120 detik. Untuk MVP dengan sedikit driver, customer akan sering melihat "tidak ada driver" hanya karena driver baru online 10 detik kemudian.

**Bug kecil di tempat yang sama.** Tanda `searched` / `researched` di-set di `zone.ts:730-731`, tapi ride langsung dibaca ulang dari storage di `zone.ts:733` sebelum disimpan, sehingga tanda `searched` **tidak pernah tersimpan**. Akibatnya perilaku asli berbeda dari niat di komentar kode (`zone.ts:739`, "search once more"): sistem terus mencari selama masih ketemu kandidat, dan berhenti setelah dua kali hasil kosong. Dampaknya tidak berbahaya (tetap dibatasi 120 detik), tapi logikanya tidak sesuai niat.

**Saran.** Sederhanakan: buang dua tanda itu. Selama belum lewat batas 120 detik, cari ulang tiap beberapa detik. Satu aturan, mudah dipahami.

#### 3.3 Driver bisa Tiba / Mulai / Selesai dari mana saja

**Masalah.** `driverRideEvent` (`zone.ts:931`) hanya mengecek "apakah ini driver ride tersebut". Posisi driver tidak dicek. Driver bisa menerima order lalu langsung menekan Tiba → Mulai → Selesai tanpa bergerak, dan untuk ride WALLET uang customer langsung berpindah.

**Saran.** Cek jarak sederhana pakai posisi terakhir driver (sudah ada di memori):
- `ARRIVE` hanya jika ≤ ±200 m dari titik jemput.
- `COMPLETE` hanya jika ≤ ±300 m dari tujuan (atau beri customer tombol "laporkan").

### P2 — Penting, tapi boleh setelah P1

#### 3.4 Driver batal = order customer ikut batal

Kalau driver membatalkan setelah menerima, ride langsung `CANCELLED` (`zone.ts:887`). Customer harus pesan ulang dari awal. Di aplikasi ride-hailing umumnya sistem **mencari driver lain** secara otomatis. Untuk MVP masih bisa diterima, tapi ini yang paling terasa bagi customer.

#### 3.5 Satu driver bisa online di dua zona

Socket lama hanya ditutup di zona **yang sama** (`zone.ts:1046`). Driver yang membuka dua perangkat/tab di dua lokasi bisa `AVAILABLE` di dua zona dan menerima dua ride. Postgres akan menolak ride kedua (`one_active_ride_driver`), tetapi ZoneDO sudah terlanjur menganggap ride itu diterima, dan penulisannya ke Postgres gagal terus sampai ride pertama selesai.

Saran murah: saat `acceptOffer`, kalau Postgres menolak karena aturan itu, batalkan penerimaan dan tawarkan ke driver berikutnya.
Catatan: `persist()` tidak pernah melempar error (`flushOnce`, `zone.ts:416-423`, menangkap semuanya lalu coba ulang),
jadi accept perlu menulis langsung ke Postgres dan membedakan pelanggaran aturan ini dari error koneksi.

#### 3.6 Pencarian berhenti kalau satu zona tetangga error

`findCandidates` memanggil semua zona tetangga dengan `Promise.all` (`zone.ts:794`). Kalau satu saja gagal, seluruh pencarian gagal dan ride diam sampai batas 120 detik. Saran: pakai `Promise.allSettled`, abaikan zona yang gagal.

#### 3.7 Tarif belum punya batas

`POST /rides` (`index.ts:173`) menerima titik jemput dan tujuan apa saja. Tujuan 1.000 km tetap diterima. Saran: tolak jarak di atas batas wajar (mis. 50 km) dan titik jemput = tujuan.

### P0 — Stabilitas dasar (ditemukan di review ulang, kerjakan sebelum P1)

#### 3.8 Dua sumber kebenaran untuk status ride

Status ride setelah dibuat diputuskan dan disimpan di DO dulu (`transition` → `saveRide`), lalu Postgres menyusul
lewat outbox (`persist`, `zone.ts:387`) yang tidak pernah melempar error. Padahal aturan lintas zona dijaga Postgres
dan dihitung dari salinan yang tertinggal itu: `one_active_ride`, pelepasan hold saldo, `one_active_ride_driver` (§3.5),
dan pembacaan REST.

Akibat paling parah: `persist` menulis baris outbox lalu langsung flush; timer `outbox:` baru dipasang kalau flush
gagal dan error-nya tertangkap (`zone.ts:409-423`). Kalau DO mati di tengah flush (deploy, batas CPU), baris outbox
yatim tanpa timer. Kalau status itu `CANCELLED`, customer terkunci `one_active_ride` dan saldo tertahan selamanya.
Klaim §2 "tahan database mati" jadi terlalu optimis.

**Saran.** Postgres dulu, baru DO: transisi ditulis langsung dalam satu transaksi, Postgres gagal → aksi ditolak.
Posisi, grid, reservasi, socket, dan timer tetap di DO. Minimal: pasang timer `outbox:` sebelum flush.

#### 3.9 Pencarian driver bisa berhenti diam-diam

- `dispatch` memegang penanda `dispatching` selama menunggu `persist` tawaran pertama (`zone.ts:720`, `:773`). Penolakan atau timeout di jendela itu memanggil `dispatch` yang langsung keluar → tidak ada yang lanjut mencari.
- RPC antar-zona (`reserveAndOffer`, `release` di `:830`) yang melempar error hanya di-log oleh `runTimer` (`:332`), tidak dicoba ulang.
- DO mati di tengah pencarian: driver sudah `RESERVED`, ride belum menyimpan tawaran.

Semuanya berakhir `NO_DRIVER` palsu setelah 120 detik. **Saran:** timer penjaga `dispatch:` yang dipasang sebelum tiap langkah.

#### 3.10 Postgres tanpa batas waktu

`pg.ts` tidak mengatur `connect_timeout` (bawaan postgres.js 30 detik) atau `statement_timeout`, dan `notifyRide`
menunggu `persist`. Postgres lambat → semua aksi dan notifikasi ikut lambat, dan jendela di §3.9 makin lebar.
Pertimbangkan juga `locationHint` agar DO dekat region Postgres.

#### 3.11 Accept gagal di jaringan

Kalau RPC `acceptOffer` (`zone.ts:1193`) melempar error padahal ride sudah `ACCEPTED` di zona ride, driver tetap
`RESERVED` di zona asal; setelah 20 detik `reserveAndOffer` menganggapnya bebas dan bisa menawarinya ride lain.

#### 3.12 Nama zona dari input tidak divalidasi

`zoneOfRide()` mengambil teks apa pun sebelum `_` (`index.ts:110`, `:219`). Siapa pun bisa membuat DO sembarang,
dan `learnZone` mencatatnya ke Postgres. **Saran:** cek `isGeohash` + panjang `zonePrecision`.

### P3 — Catatan, tidak mendesak

- **`zone.ts` terlalu besar** (1.255 baris: posisi driver, pencarian, status ride, pembayaran, outbox, WebSocket). Belum perlu dipecah jadi layanan baru; cukup dipisah jadi beberapa file saat menyentuh bagian tersebut.
- **Arsitektur sudah lebih canggih dari kebutuhan MVP** (dua penyimpanan + outbox + recovery). Ini sudah jadi dan dites, jadi biarkan. Tapi jangan tambah lagi: TODO Tahap 3–5 (Queues, shard, VM Rust) sebaiknya ditunda sampai ada pengguna nyata.
- **Driver yang socket-nya putus tetap `AVAILABLE`** sampai 1 jam. Saat tersambung lagi ia langsung aktif tanpa cek saldo ulang (`zone.ts:1059`). Tidak ikut pencarian selama putus, jadi aman; hanya perlu diketahui.
- **REST dan WebSocket membaca sumber berbeda.** WebSocket dari ZoneDO (terbaru), `GET /rides/:id` dari Postgres (bisa telat saat database lambat).
- **Login tanpa OTP** (`index.ts:79`): siapa pun bisa masuk sebagai nomor siapa pun. Sudah dicatat di README sebagai langkah berikutnya; wajib sebelum ada uang sungguhan.
---

## 4. Urutan kerja yang disarankan

Urutan lengkap dan syarat selesai ada di [TODO.md](TODO.md) Tahap A. Ringkasnya:

| # | Pekerjaan | Kenapa |
|---|---|---|
| A1 | Batas waktu Postgres (3.10) | Kecil; prasyarat A2 |
| A2 | Status ride Postgres dulu, baru DO (3.8) | Outbox yatim = customer terkunci & saldo tertahan selamanya |
| A3 | Timer penjaga `ON_TRIP` + endpoint admin (3.1) | Satu HP mati saat perjalanan = customer terkunci |
| A4 | Pencarian driver yang andal (3.2, 3.6, 3.9) | `NO_DRIVER` palsu walau driver ada |
| A5 | Cek jarak Tiba & Selesai (3.3) | Celah curang paling mudah |
| A6 | Driver tidak boleh punya dua ride (3.5, 3.11) | Jarang, tapi data jadi tidak sinkron |
| A7 | Validasi input zona & jarak tarif (3.7, 3.12) | Penyalahgunaan & tarif tidak wajar |
| A8 | Driver batal → cari driver lain (3.4) | Pengalaman customer |

Tiap butir sebaiknya disertai test di `apps/api/test/ride.test.ts`.
