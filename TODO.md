# TODO — Scalability

Urutan: fondasi data (Postgres) dulu, lalu quick wins di ZoneDO, lalu refactor struktural & infra baru.
Angka biaya = estimasi kasar untuk skenario 10k driver online, 100k ride/hari, ping lokasi tiap 5 detik.

## Aturan biaya (jangan dilanggar saat refactor)

- **Jangan tulis SQLite DO per ping lokasi.** 5,2 miliar ping/bln × $1/juta rows written ≈ $5.000/bln.
- **Jangan buat 1 DO per ride.** DO yang terus dibangunkan ping ditagih duration ~190 GB-s/ride ≈ $7.000/bln. Pakai shard tetap.
- **Jangan relay tiap ping lewat RPC antar-DO.** Pesan WS masuk ditagih 20:1, RPC 1:1 (≈ $780/bln). Socket driver langsung ke DO pemilik state.

---

## Tahap 1 — Pindah ke Postgres (D1 dihapus)

Tulis ke Postgres **tetap sinkron** dulu (`await`, sama seperti D1 sekarang). Outbox/Queues menyusul di Tahap 3
setelah load test membuktikan perlu — jangan bangun dua hal sekaligus.

- [x] **1. Infra lokal & binding**
  - `docker-compose.yml` Postgres 17 untuk dev/test; DB terpisah `gojek_test` dan `gojek_e2e`.
  - Binding Hyperdrive di `apps/api/wrangler.jsonc` (`localConnectionString` untuk dev), flag `nodejs_compat`, driver `postgres` (postgres.js).
  - **Matikan query caching Hyperdrive** (`--caching-disabled`): saldo & ride aktif tidak boleh dibaca basi.
  - Pastikan binding Hyperdrive juga terpakai dari `ZoneDO` (bukan hanya Worker). ✔ lokal; di produksi cek lagi saat deploy pertama.
  - Selesai jika: `pnpm dev` jalan dengan Postgres lokal; `wrangler d1` tidak dipakai lagi.

- [x] **2. Skema & migrasi**
  - Port `apps/api/migrations/*.sql` ke Postgres (SQL polos + `apps/api/scripts/migrate.mjs`); tipe `BIGINT` untuk uang & epoch ms.
  - Tambahan sekaligus:
    ```sql
    -- satu ride aktif per customer, dijamin DB (menutup race dua zona)
    CREATE UNIQUE INDEX one_active_ride ON rides (customer_id)
      WHERE status IN ('REQUESTED','OFFERING','ACCEPTED','ARRIVED','ON_TRIP');
    -- satu ride aktif per driver
    CREATE UNIQUE INDEX one_active_ride_driver ON rides (driver_id)
      WHERE status IN ('ACCEPTED','ARRIVED','ON_TRIP');
    ```
  - Tabel `wallet_holds` (ride_id, user_id, amount, status) untuk hold saldo ride WALLET.

- [x] **3. Tulis ulang `apps/api/src/db.ts` ke Postgres**
  - `settleRide`: transaksi biasa (`BEGIN … SELECT … FOR UPDATE … COMMIT`) menggantikan guard `EXISTS` ala D1 batch; tetap idempotent lewat `UNIQUE(ride_id, user_id, type)` + `paid_at IS NULL`.
  - `topup`: `INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING` lalu update saldo dalam transaksi yang sama.
  - Ride WALLET: hold saldo saat create, capture saat selesai, release saat batal — tidak ada lagi fallback diam-diam ke cash.
  - Selesai jika: `wallet.test.ts` & `ride.test.ts` hijau di Postgres; `balance == SUM(amount)` per user.

- [x] **4. Create ride sinkron + kunci ride aktif global**
  - `ZoneDO.createRide` insert baris ride ke Postgres **sebelum** dispatch; unique violation (`23505` pada `one_active_ride`) → `ACTIVE_RIDE_EXISTS`.
  - Hapus cek ride aktif per-zona di DO dan cek ganda di Worker (`POST /rides`).
  - Selesai jika: test baru — dua `POST /rides` paralel dengan pickup di zona berbeda → tepat satu sukses.

- [x] **5. WS connect tanpa DB**
  - Andalkan JWT (`sub`, `role`, `name` sudah ada — `apps/api/src/auth.ts`); hapus `getUser` di `/ws`.
  - Client selalu kirim `rideId` atau `lat/lng`; lookup ride aktif ke Postgres hanya fallback.
  - Selesai jika: jalur `/ws` normal = 0 query DB (badai reconnect saat deploy tidak menghantam Postgres).

- [x] **6. Pendapatan harian driver pakai agregat SQL**
  - Ganti hitung dari `listRides` (limit 50 → salah untuk driver > 50 ride/hari) dengan `COUNT/SUM … WHERE completed_at >= start_of_day`.

- [x] **7. Tes & dev reset**
  - `vitest` (pool workers) pakai Hyperdrive lokal ke `gojek_test`; `TRUNCATE … RESTART IDENTITY CASCADE` antar file test.
  - `/dev/reset` dan e2e (`pnpm e2e`) pakai `gojek_e2e`; CI menyalakan Postgres service.
  - Update README (quick start, deploy) & ARCHITECTURE (D1 → Postgres).

---

## Tahap 2 — Quick wins ZoneDO (tidak menyentuh Postgres, bisa paralel dengan Tahap 1)

- [x] **8. Index `nearest` yang benar** — diganti grid di memori (#10): `nearest` tidak query SQL per sel lagi, hanya lookup status by primary key.
  - Masalah: `WHERE substr(cell,1,?) IN (...)` (`apps/api/src/zone.ts` `nearest`) tidak pakai index → full scan driver zona.
  - Kerja: kolom `cell5` + `cell6` ber-index, query `WHERE cell6 IN (...)`.
  - Selesai jika: `EXPLAIN QUERY PLAN` menunjukkan `USING INDEX`.

- [x] **9. Throttle ping lokasi**
  - Server: abaikan `loc` < 2 dtk sejak ping terakhir (ON_RIDE: batas 1 dtk) **kecuali bergerak ≥ 30 m** (lompatan posisi tidak boleh dibuang).
  - Client: kirim hanya jika bergerak > 30 m atau sudah 5 dtk.

- [x] **10. Posisi driver di memori, SQLite hanya saat status berubah** ⭐ impact biaya terbesar
  - `Map<driverId, {lat,lng,heading,ts}>` + grid `Map<cell6, Set<driverId>>` di memori; snapshot posisi ke SQLite tiap ~30 dtk untuk recovery.
  - Selesai jika: rows written per driver per jam turun dari ~720 ke < 150; matching benar setelah DO di-evict. (Belum diukur — ikut load test #14.)

- [x] **11. Reconnect jitter + hysteresis zona**
  - Client (`packages/client/src/socket.ts`): backoff eksponensial + jitter 0–5 dtk.
  - `maybeHandOff`: pindah zona hanya jika > 100 m di dalam zona baru atau 3 ping berturut-turut.
  - Catatan: selama masa tunggu hysteresis (≤ ~15 dtk) driver di pita batas tidak terlihat oleh pencarian dari zona baru.

- [x] **12. Alarm zona tanpa head-of-line blocking**
  - Timer jatuh tempo dijalankan paralel (`Promise.allSettled`, batas ~16); cache waktu alarm di memori.
  - Selesai jika: satu RPC/DB lambat (mock 2 dtk) tidak menunda offer timeout ride lain. (Belum ada test khusus.)

- [x] **13. Rate limit**
  - Binding Rate Limiting Cloudflare di `/auth/login` (per IP) dan `/ws` (per user).

---

## Tahap 3 — Ukur, lalu refactor struktural

- [ ] **14. Load test baseline**
  - Fleet headless (k6 WebSocket atau script Bun): 1k → 5k driver di satu zona, N customer paralel.
  - Catat: latensi offer, durasi DO, rows written, latensi & koneksi Postgres, error rate.

- [ ] **15. Outbox + Queues (bila #14 menunjukkan write sinkron jadi bottleneck)**
  - Sudah ada: outbox SQLite DO → Postgres dengan retry (untuk kebenaran, lihat ARCHITECTURE-REVIEW R1). Sisa: flush batch lewat Queues bila perlu throughput.
  - ZoneDO tulis transisi ride ke tabel `outbox` di SQLite DO → alarm flush batch ke Cloudflare Queues → consumer upsert dengan kolom `version`.
  - Create ride & settlement tetap sinkron (butuh kunci & transaksi).

- [ ] **16. RideShardDO (pisah state ride dari zona jemput)**
  - N shard tetap per kota (mis. 64), `shard = hash(rideId) % N`; pegang state machine, timer, socket driver & customer selama trip.
  - ZoneDO tinggal geo index + reservasi + matching.
  - Selesai jika: load test dengan 80% pickup di satu zona tidak menaikkan latensi zona tsb.

---

## Tahap 4 — VM Rust (kualitas matching & job berat)

Akses VM hanya lewat Cloudflare Tunnel + Access service token. Service Rust **stateless**; ZoneDO fallback ke haversine + greedy jika VM timeout > 200 ms.

- [ ] **17. routing-svc** — ETA lewat jalan: Rust + `fast_paths` dari OSM Jabodetabek (atau OSRM/Valhalla). `POST /matrix { sources, target }`.
- [ ] **18. Batch matching (matcher-svc)** — tiap ~2 dtk: matriks ETA + Hungarian/min-cost flow → ZoneDO reservasi hasilnya.
- [ ] **19. ingest-svc + jobs** — consumer Queues → Postgres (`COPY`/multi-row upsert); cron rekonsiliasi ledger, payout, fraud GPS, heatmap demand.

---

## Tahap 5 — Nanti (hanya bila data menunjukkan perlu)

- [ ] **20. Zona adaptif** — tabel `prefix → presisi` di KV; pertimbangkan H3 menggantikan geohash.
- [ ] **21. Skala Postgres** — partisi `rides` per bulan, read replica untuk riwayat, Citus bila primary jenuh.
- [ ] **22. Realtime core di Rust** — ganti ZoneDO hanya jika tagihan duration DO > biaya engineer yang mengoperasikan cluster sendiri.
