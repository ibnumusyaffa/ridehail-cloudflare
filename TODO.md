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

- [x] **A3. Ride `ON_TRIP` tidak boleh macet selamanya** (§3.1)
  - Timer `watch:<rideId>` di ZoneDO, dipasang saat `START` (dan ulang di `rearmTimers` untuk tiap ride `ON_TRIP`). Membaca ping terakhir di memori (`pos.ts`), tidak ada tulis per ping.
  - Driver tanpa ping `DRIVER_LOST_ASK_MS` (1 jam) → customer ditanya lewat WS `ride.driver_lost`, diulang tiap 1 jam. Jawaban `POST /rides/:id/driver-lost {action}`: `arrived` → `COMPLETE` (dibayar), `cancel` → `CANCEL` oleh `system` (`driver_lost_reported`, hold dilepas penuh). "Masih jalan" = tidak kirim apa-apa.
  - Tanpa ping `DRIVER_LOST_CANCEL_MS` (3 jam) dan tidak dijawab → `CANCEL` oleh `system` (`driver_lost`), hold dilepas penuh.
  - Driver ping lagi → `ride.driver_back`, pertanyaan ditarik; jawaban customer ditolak (`INVALID_TRANSITION`).
  - State machine: `system` boleh `CANCEL` dari `ON_TRIP`. Customer tetap tidak bisa batal `ON_TRIP` lewat `/cancel`.
  - Dites: `test/driver-lost.test.ts`.
  - Sisa: endpoint admin paksa batal / paksa selesai (butuh autentikasi admin); `ACCEPTED` terlalu lama tanpa `ARRIVED` (customer masih bisa batal sendiri). Risiko diterima: customer bisa bohong "ada masalah" untuk perjalanan gratis; driver protes manual (`cancel_reason` jadi jejak).

### P1 — Hasil salah / bisa dicurangi

- [x] **A4. Pencarian driver yang andal** (§3.2, §3.6, §3.9)
  - `dispatch` jalan di lane ride (`serial`), penanda `dispatching` dibuang. Tolak / terima / batal yang datang di tengah langkah menunggu, tidak hilang. `offerRejected`, timeout tawaran, dan `DRIVER_BUSY` cukup memasang `dispatch:` di `now`.
  - Timer penjaga `dispatch:` (`DISPATCH_RETRY_MS`, 2 detik) dipasang sebelum tiap langkah yang bisa gagal, diganti `offer:` setelah tawaran berdiri. `rearmTimers` memasang `dispatch:` untuk tiap ride `REQUESTED`/`OFFERING` (DO mati di tengah langkah).
  - Tawaran ditulis dulu (`offer.reserving`) sebelum RPC `reserveAndOffer`. RPC error / DO mati → driver yang sama dicoba ulang (maks `RESERVE_TRIES` = 3), lalu kandidat berikutnya. `reserveAndOffer` idempotent per ride.
  - Tanda `searched` / `researched` dibuang. Aturan: selama belum lewat `searchDeadline`, cari ulang tiap `RESEARCH_DELAY_MS`; `NO_DRIVER` dari timer `search:`.
  - `findCandidates`: `Promise.allSettled`, zona gagal dilewati; kalau semua zona gagal, langkah gagal dan timer penjaga mengulang.
  - Dites: `test/dispatch.test.ts`. Test lama memakai `SEARCH_TIMEOUT_MS=3000`.
  - Sisa: belum ada test untuk DO mati di tengah pencarian (`rearmTimers`).

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

- [x] **A8. Driver batal → cari driver lain** (§3.4)
  - Event baru `REQUEUE`: `ACCEPTED/ARRIVED → REQUESTED`. Driver tidak lagi bisa `CANCEL`; `/rides/:id/cancel` dari driver = `REQUEUE` (alasan tetap wajib).
  - Postgres: satu transaksi `transitionRide` mengosongkan `driver_id`, `accepted_at`, `arrived_at`. Hold saldo tetap `ACTIVE` (customer masih memesan). Catatan: `one_active_ride_driver` adalah partial index (`ACCEPTED/ARRIVED/ON_TRIP`), jadi driver sudah lepas begitu status `REQUESTED`; `driver_id` dikosongkan supaya REST, riwayat driver, dan pemulihan tidak menunjuk driver lama.
  - ZoneDO (`adopt`): driver masuk `rejected` + `dropoutDrivers`, `searchDeadline` diulang, timer `search:` + `dispatch:` dipasang, driver jadi `AVAILABLE`. Customer menerima `ride.requeued` lalu `ride.status` `REQUESTED`.
  - Batas `MAX_REQUEUES` (3): driver ke-(N+1) yang batal → `CANCEL` oleh `system` (`drivers_cancelled`), hold dilepas.
  - Pemulihan: `EVENT_FOR.REQUESTED = REQUEUE`, hanya diikuti kalau ride di DO punya driver (OFFERING di DO = REQUESTED di Postgres). Ulang batal dari driver yang sama setelah sukses → 200 (idempotent).
  - Dites: `test/requeue.test.ts`.
  - Sisa: jejak driver yang batal hanya di DO (`dropoutDrivers`); untuk penalti / cancel rate perlu tabel audit di Postgres.

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
