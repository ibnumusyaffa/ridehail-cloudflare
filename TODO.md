# TODO

Urutan: **logic ride-hailing untuk MVP dulu**, baru skalabilitas.
Penjelasan tiap temuan ada di [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) (nomor § di bawah merujuk ke sana).

Tiap butir dianggap selesai kalau ada test-nya di `apps/api/test/`.

---

## Tahap A — Stabilitas & logic MVP (urut dari paling kritis)

Tiga level: **P0** = data rusak / user terkunci selamanya, **P1** = hasil salah atau bisa dicurangi, **P2** = perbaikan kecil & pengalaman.
Kerjakan berurutan; nomor kecil sering jadi prasyarat nomor besar.

### P0 — Data rusak / user terkunci

- [x] **A1. Batas waktu Postgres** (§3.10) — kecil, prasyarat A2
  - `pg.ts`: `connect_timeout` 5 detik; `withDb` batas 8 detik per operasi (`DbTimeoutError`); transaksi lewat `begin()` dengan `SET LOCAL statement_timeout` 5 detik.
  - `locationHint` DO lewat var `DO_LOCATION_HINT` (`zoneStub()` di `config.ts`). Hanya berlaku untuk DO yang baru dibuat.
  - Sisa: query Worker di luar transaksi belum punya batas sisi klien (hanya batas 60 detik Hyperdrive).
  - Kenapa duluan: setelah A2 tiap transisi menunggu Postgres; tanpa batas waktu, Postgres lambat = semua aksi menggantung ±30 detik.

- [x] **A2. Status ride: Postgres dulu, baru DO** (§3.8) ⭐
  - Transisi accept / arrive / start / complete / cancel / `NO_DRIVER`: cek state machine di DO → catat `pending` + timer `sync:` → satu transaksi Postgres (`transitionRide`, compare-and-set pada `rides.version`, migrasi `0002`) → baru diterapkan di DO + `notifyRide`. Selesai sekalian membayar dalam transaksi yang sama.
  - Postgres gagal / balasan hilang → `UNAVAILABLE`, status tidak berubah. Pemulihan memakai *fence* (`fenceRide`): menaikkan versi supaya tulisan lama pasti tidak commit belakangan, atau mendapati tulisan itu sudah commit lalu menerapkannya. "Ditolak" selalu berarti "tidak terjadi".
  - Aksi satu ride diantrikan (`serial`) supaya `arrive → start → complete` beruntun tetap berurutan. Timer pekerjaan yang menunggu Postgres dipasang ulang saat DO menyala (`rearmTimers`).
  - Outbox dihapus (tabel di-DROP; belum pernah di-deploy). `OFFERING` hanya di DO; Postgres tetap `REQUESTED` selama mencari.
  - Dites: `test/resilience.test.ts` (cancel/complete saat Postgres mati, balasan hilang, tidak ada yang mengulang, accept vs cancel bersamaan).

- [ ] **A3. Ride `ON_TRIP` tidak boleh macet selamanya** (§3.1)
  - Timer penjaga baru di ZoneDO (jenis `watch:`): driver tanpa ping lama saat `ON_TRIP` (juga `ACCEPTED` terlalu lama tanpa `ARRIVED`, kurang mendesak karena customer masih bisa batal).
  - Tindakan: batalkan oleh `system` (sebelum `ON_TRIP`) atau tandai bermasalah (saat `ON_TRIP`). `ON_TRIP` perlu aturan baru di `packages/core/src/rideStateMachine.ts`.
  - Endpoint admin: paksa batal / paksa selesai satu ride. Belum ada peran admin (`Role` hanya `customer | driver`): tentukan autentikasinya dulu (mis. header `ADMIN_TOKEN` atau peran baru).
  - Putuskan nasib saldo tertahan saat ride `ON_TRIP` diakhiri paksa: dilepas penuh, ditarik sebagian, atau ditarik penuh.
  - Selesai jika: driver hilang di `ON_TRIP` → customer bisa pesan lagi dan saldo tertahan dilepas.

### P1 — Hasil salah / bisa dicurangi

- [ ] **A4. Pencarian driver yang andal** (§3.2, §3.6, §3.9) — satu fungsi (`dispatch` / `findCandidates`), kerjakan sekaligus
  - Timer penjaga `dispatch:` yang selalu ada selama `REQUESTED`/`OFFERING`, dipasang sebelum tiap langkah (reserve, release, persist). Menutup: panggilan `dispatch` yang terbuang oleh penanda `dispatching`, RPC antar-zona yang gagal (`runTimer` hanya log), DO mati di tengah pencarian.
  - Buang tanda `searched` / `researched` (`searched` tidak pernah tersimpan, `zone.ts:730-733`). Aturan baru: selama belum lewat `SEARCH_TIMEOUT_MS`, cari ulang tiap `RESEARCH_DELAY_MS`.
  - `findCandidates`: `Promise.allSettled`, zona tetangga yang gagal diabaikan.
  - Selesai jika: (1) driver menolak saat tawaran pertama masih ditulis → ride lanjut ke kandidat berikutnya; (2) RPC `reserveAndOffer` yang error dicoba ulang; (3) driver yang online 20 detik setelah order tetap ditawari, `NO_DRIVER` baru setelah 120 detik.

- [ ] **A5. Cek lokasi untuk Tiba dan Selesai** (§3.3)
  - `ARRIVE` hanya jika driver dekat titik jemput; `COMPLETE` hanya jika dekat tujuan. Jarak batas masuk config.
  - Pakai posisi terakhir di memori (`pos`). `pos` bisa kosong setelah DO restart atau pindah zona: jatuh ke `lat/lng` di `DriverRow` (snapshot ≤30 detik), dan kalau tetap tidak ada, tolak dengan error yang jelas.
  - Selesai jika: Tiba dari 2 km ditolak dengan error yang jelas.

- [ ] **A6. Driver tidak boleh punya dua ride** (§3.5, §3.11)
  - ~~Dua zona: Postgres menolak accept karena `one_active_ride_driver` → tawarkan ke kandidat berikutnya.~~ Selesai bersama A2 (`DRIVER_BUSY` → `dropOffer` + `dispatch`); belum ada test khusus.
  - Accept `UNAVAILABLE` (A2): zona driver kini tetap memegang reservasi, dan kalau ternyata tidak commit, timer tawaran melepasnya. Tapi kalau accept ternyata commit lewat pemulihan `sync:`, zona driver belum diberi tahu (driver tidak dipindah ke zona ride sampai mengulang accept). Perlu RPC pemberitahuan ke zona driver.
  - Accept gagal di jaringan: kalau RPC `acceptOffer` melempar error (bukan `!res.ok`), jangan biarkan driver jatuh ke status bebas setelah reservasi habis; tanya ulang zona ride atau perpanjang reservasi sampai jelas.

### P2 — Perbaikan kecil & pengalaman

- [ ] **A7. Validasi input** (§3.7, §3.12)
  - `zoneOfRide()` di `index.ts` (`/ws?rideId=`, `/rides/:id/cancel`): tolak kalau bukan geohash dengan panjang `zonePrecision`.
  - `POST /rides`: tolak jarak di atas batas dan titik jemput = tujuan.

- [ ] **A8. Driver batal → cari driver lain** (§3.4)
  - Ride kembali ke pencarian, driver yang batal masuk daftar `rejected`. Butuh transisi baru `ACCEPTED/ARRIVED → REQUESTED`.
  - Ikut diurus: kosongkan `driverId` / `driver`, ulang `searchDeadline`, kabari customer lewat WebSocket ("mencari driver lagi").
  - Di Postgres `driver_id` juga harus dikosongkan, kalau tidak `one_active_ride_driver` tetap mengunci driver yang batal.

## Tahap B — Sebelum ada pengguna & uang sungguhan

- [ ] **B1. Login OTP** — sekarang siapa pun bisa masuk dengan nomor siapa pun.
- [ ] **B2. Pisah `zone.ts`** (1.255 baris) jadi beberapa file: posisi driver, pencarian, status ride (transisi + sync), pembayaran, WebSocket. Tanpa mengubah perilaku.
- [ ] **B3. Deploy pertama** — pastikan Hyperdrive terpakai dari ZoneDO di produksi, bukan hanya Worker.
- [ ] **B4. Payment gateway & penarikan saldo driver.**
- [ ] **B5. Catatan kecil dari review (P3)** — driver yang socket-nya putus tetap `AVAILABLE` sampai 1 jam dan tidak dicek saldo ulang saat tersambung lagi; REST (`GET /rides/:id`, Postgres) dan WebSocket (ZoneDO) kini sama setelah A2, kecuali `OFFERING` (REST menampilkan `REQUESTED`); `purge` tidak menghapus driver `RESERVED` yang kedaluwarsa; `Idempotency-Key` dibuat baru tiap panggilan di `packages/client/src/api.ts`.

---

## Tahap C — Skalabilitas (tunda sampai ada beban nyata)

Jangan dikerjakan sebelum Tahap A selesai dan ada hasil ukur.

- [ ] **C1. Load test** — 1k → 5k driver di satu zona. Catat latensi tawaran, durasi DO, rows written, koneksi Postgres.
- [ ] **C2. Tulis Postgres lewat Queues** — hanya bila C1 menunjukkan tulis ke Postgres jadi penghambat. Setelah A2 status ride ditulis langsung; ini hanya relevan untuk data non-kritis (riwayat, statistik).
- [ ] **C3. RideShardDO** — pisah state ride dari zona jemput (N shard tetap, `hash(rideId) % N`).
- [ ] **C4. ETA lewat jalan & batch matching** — layanan terpisah; ZoneDO tetap punya cadangan jarak lurus.
- [ ] **C5. Zona adaptif, partisi tabel `rides`, read replica.**

### Aturan biaya (jangan dilanggar saat refactor)

Perkiraan kasar untuk 10k driver online, 100k ride/hari, ping tiap 5 detik.

- **Jangan tulis SQLite DO per ping lokasi.** ≈ $5.000/bulan.
- **Jangan buat 1 DO per ride.** ≈ $7.000/bulan. Pakai shard tetap.
- **Jangan teruskan tiap ping lewat RPC antar-DO.** Socket driver langsung ke DO pemilik state.

---

## Sudah selesai

- Pindah dari D1 ke Postgres (Hyperdrive, cache mati); skema + migrasi.
- Satu ride aktif per customer / driver dijaga Postgres; ride dibuat di Postgres sebelum dispatch.
- Saldo tertahan (hold) → capture / release; pembayaran dan top-up aman diulang.
- Status ride Postgres dulu (compare-and-set + fence, A2); recovery pembuatan ride; retry pembayaran.
- WebSocket connect tanpa query database (`known=1`).
- Pendapatan harian driver dengan agregat SQL.
- Posisi driver di memori + grid geohash 6; snapshot ke SQLite tiap 30 detik.
- Throttle ping lokasi (server + client); reconnect dengan jitter; pindah zona dengan hysteresis.
- Timer zona dijalankan paralel (maks 16); rate limit login dan WebSocket.
