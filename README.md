# Ride-Hailing MVP — backend Cloudflare

Backend aplikasi ojek online (gaya Gojek/Uber) di atas Cloudflare Workers + Durable Objects,
dengan Postgres sebagai penyimpanan utama. Monorepo Turborepo + pnpm.

Dokumen lain: [PLAN.md](PLAN.md) (rencana awal) · [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) (review & temuan) · [TODO.md](TODO.md) (pekerjaan berikutnya).

```
packages/core              logika murni tanpa I/O: geohash, pencarian driver, status ride, tarif, pembayaran
packages/client            client bersama: REST, WebSocket (reconnect / pindah zona), tipe pesan, peta & UI React
apps/api                   Worker (REST + gerbang WebSocket) + MatchDO & RideDO (dua petugas per zona) + Postgres
apps/simulator-customer    aplikasi web customer (Vite + React + MapLibre)   :5173
apps/simulator-driver      aplikasi web driver dengan autopilot              :5174
apps/e2e                   Playwright: test e2e + demo langsung
```

## Mulai cepat

Butuh Docker (Postgres lokal di port 54329; database `gojek`, `gojek_test`, `gojek_e2e`).

```sh
pnpm install
pnpm db:up                                   # Postgres 17 lewat docker compose
cp apps/api/.dev.vars.example apps/api/.dev.vars   # JWT_SECRET + DEV_RESET untuk lokal
pnpm test                                    # unit test core + integration test api (pakai gojek_test)
pnpm dev                                     # API :8787 + customer :5173 + driver :5174 (migrasi otomatis)
```

Buka http://localhost:5173 (customer) dan http://localhost:5174 (driver) di dua jendela.

1. Driver: pilih lokasi (atau geser 🛵) → **Go online**.
2. Customer: pilih rute (atau klik peta) → **Pesan**.
3. Driver: terima tawaran. Autopilot menggerakkan motor; tekan Tiba → Mulai → Selesai.

Perintah lain:

```sh
pnpm demo:live                      # Playwright membuka dua jendela dan memainkan satu ride penuh
pnpm demo:live -- --trip gbk-blokm  # rute lain: monas-hi | gbk-blokm | kota-ancol | kuningan-senopati
pnpm demo:record                    # sama, video disimpan ke apps/e2e/videos/
pnpm e2e                            # test e2e di stack terpisah (port 8788/5273/5274, DB gojek_e2e)
pnpm typecheck
```

Pertama kali saja: `pnpm --filter @gojek/e2e exec playwright install chromium`.

**Reset data**: tombol 🔄 Reset di kedua aplikasi memanggil `POST /dev/reset` dan menghapus semua
user, ride, saldo, dan zona. Hanya aktif jika API jalan dengan `DEV_RESET=1`; di produksi balasannya 404.

**Rute jalan**: peta dan autopilot memakai OSRM publik (`packages/client/src/route.ts`), jatuh ke garis lurus
kalau gagal. Ganti dengan `VITE_OSRM_URL=<server>` atau matikan dengan `VITE_OSRM_URL=off`.
Tarif di backend tetap memakai jarak lurus × 1,3.

## Cara kerja

| Bagian | File | Tugas |
|---|---|---|
| Worker | `apps/api/src/index.ts` | Pintu masuk. Cek token, validasi input, teruskan ke zona yang tepat. |
| MatchDO | `apps/api/src/match.ts` | Petugas pencarian satu zona (`match:<zona>`, geohash 5, ±5 km). Memegang driver bebas (`OFFLINE`/`AVAILABLE`/`RESERVED`) dan posisinya, menjawab pencarian, mereservasi driver. |
| RideDO | `apps/api/src/ride.ts` | Petugas ride satu zona (`ride:<zona>`), atau beberapa petugas untuk zona ramai (shard, `ride:<zona>.<k>`). Memegang ride yang titik jemputnya di zona itu: dispatch, status, timer, rute, pembayaran; plus socket customer dan driver yang sedang `ON_RIDE`. |
| (bersama) | `apps/api/src/actor.ts` | Dasar kedua DO: timer di satu alarm, socket, posisi driver, jalur Postgres. |
| Postgres | `apps/api/src/db.ts`, `apps/api/migrations` | User, kendaraan, riwayat ride, saldo, transaksi, saldo tertahan. |

Alur satu ride:

```
Customer pesan
  → Postgres mencatat ride (+ menahan saldo kalau WALLET)
  → RideDO bertanya ke MatchDO (zona jemput + tetangga), menawari satu driver per kali (15 detik)
  → Terima → ACCEPTED → Tiba → ARRIVED → Mulai → ON_TRIP → Selesai → COMPLETED
  → Pembayaran diproses di Postgres
```

Status ride: `REQUESTED → OFFERING → ACCEPTED → ARRIVED → ON_TRIP → COMPLETED`, atau `CANCELLED` / `NO_DRIVER`.
Status driver: `OFFLINE`, `AVAILABLE`, `RESERVED` (sedang ditawari), `ON_RIDE`.

### Zona dan pencarian driver

- ID ride = `<home>_<uuid>`, dengan home = `<zona>` (shard 0) atau `<zona>.<k>` (shard k). Siapa pun tahu petugas pemilik ride tanpa lookup.
- **Shard RideDO** untuk zona ramai: `RIDE_SHARDS` (mis. `qqguw=8,*=1`). Ride baru dibagi ke shard menurut customer (`shardFor`, hash id customer), jadi pesan ulang dengan `Idempotency-Key` yang sama sampai ke shard yang sama. Ride berjalan tetap di shard yang tertulis di ID-nya, jadi jumlah shard boleh dinaikkan/diturunkan kapan saja. Semua shard satu zona memakai MatchDO yang sama (satu kumpulan driver bebas).
- Posisi driver disimpan **di memori** DO yang memegangnya (+ grid geohash 6 di MatchDO), disalin ke SQLite tiap 30 detik. Satu ping lokasi tidak menulis ke storage.
- Pencarian: sel geohash 6 + 8 tetangga dulu; kalau kosong, geohash 5 + 8 tetangga. Maksimal 2 km dari titik jemput (`maxRadiusM` di `packages/core/src/matcher.ts`, jarak lurus), 10 kandidat terdekat. Zona tetangga ditanya paralel.
- Tawaran berurutan. `reserveAndOffer` hanya berhasil untuk driver `AVAILABLE` yang tersambung; kalau gagal lanjut kandidat berikutnya. Tawaran 15 detik, reservasi 20 detik.
- Pencarian berhenti (`NO_DRIVER`) setelah dua kali hasil kosong (jeda 5 detik) atau lewat 2 menit. Lihat catatan di [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) §3.2.
- Setelah menerima, driver **pindah ke RideDO** zona ride selama perjalanan (`zone.moved` dengan `rideId` → client reconnect), jadi customer, driver, dan ride ada di satu RideDO. Selesai / batal / driver mundur → RideDO mengembalikan driver ke MatchDO zona tempat ia berada (`returnDriver`), lalu `zone.moved` tanpa `rideId`.
- Saat pindah, server tidak menutup socket lama; client yang menutup. Pesan yang terkirim di sela itu (`loc`, `ride.*`) diteruskan MatchDO ke RideDO, tidak hilang.
- Driver `AVAILABLE` yang keluar zona dipindah setelah ≥ 100 m di dalam zona baru atau 3 ping berturut-turut di luar.
- Ping lokasi: server membuang ping yang datang < 2 detik (saat ride: < 1 detik) **dan** bergerak < 30 m.
- **Rute perjalanan**: ping saat `ON_TRIP` dirampingkan dulu (`sampleTrack`, `packages/core/src/track.ts`): disimpan satu titik tiap `TRACK_MIN_GAP_M` (200 m) atau `TRACK_MAX_GAP_MS` (1 menit), plus titik di mana garis yang disimpan akan menyimpang > `TRACK_TOLERANCE_M` (25 m) dari ping driver (belokan, tikungan), plus posisi terakhir saat ride berakhir. Titik yang lolos dicatat di SQLite RideDO (tabel `track`), lalu dikirim ke Postgres (`ride_track`) tiap `TRACK_FLUSH_MS` (1 menit) dan sekali lagi saat ride berakhir. Postgres mati → titik menunggu di RideDO, tidak hilang dan tidak dobel (`seq` jadi kunci). Posisi di luar `ON_TRIP` tidak disimpan.

### Yang dijaga Postgres

- Satu ride aktif per customer (`one_active_ride`) dan per driver (`one_active_ride_driver`), lintas zona.
- `POST /rides` dan top-up tidak dobel berkat `Idempotency-Key`.
- **Saldo**: ride WALLET menahan tarif (`wallet_holds`) dalam transaksi yang sama dengan pembuatan ride; ditolak (402) kalau saldo kurang. Batal / tidak ada driver → saldo dilepas.
- **Pembayaran** (`settleRide`): satu transaksi, aman diulang. WALLET: customer bayar, driver dapat tarif − komisi. CASH: driver berutang komisi. `wallets.balance` selalu sama dengan jumlah transaksinya.
- Driver di bawah `DRIVER_MIN_BALANCE` tidak bisa online.

### Status ride: Postgres dulu, baru RideDO

- Tiap transisi (accept, tiba, mulai, selesai, batal, `NO_DRIVER`) dicek di state machine RideDO, ditulis ke Postgres dalam satu transaksi (compare-and-set pada `rides.version`), **baru** diterapkan di RideDO dan dikirim lewat WebSocket. Batal/`NO_DRIVER` melepas saldo tertahan, selesai sekalian membayar, semuanya dalam transaksi yang sama.
- Postgres menolak (mis. driver sudah punya ride aktif) → RideDO ikut Postgres, aksi gagal dengan error yang jelas.
- Postgres mati / balasan hilang → aksi dibalas `UNAVAILABLE` (503), status tidak berubah. Transisi dicatat "pending" dengan timer `sync:` **sebelum** Postgres ditanya. Timer itu (atau aksi berikutnya) melakukan *fence*: menaikkan `version` dari nilai yang diharapkan. Fence menang → tulisan lama pasti tidak pernah commit. Fence kalah → tulisan sudah commit dan diterapkan sekarang. Jadi "ditolak" selalu berarti "tidak terjadi".
- Aksi pada satu ride berjalan satu per satu sesuai urutan datang.
- `OFFERING` hanya ada di RideDO; di Postgres ride yang sedang mencari tetap `REQUESTED`.

### Tahan gangguan database

- **Pembuatan ride**: dicatat "pending" di RideDO sebelum Postgres ditanya; kalau hasilnya tidak jelas, timer `create:` mengecek ulang.
- **Pembayaran**: biasanya ikut transaksi "selesai". Kalau tidak (balasan hilang), timer `settle:` mengulang sampai terbayar; driver tetap dibebaskan.
- Semua timer (`dispatch:`, `offer:`, `search:`, `sync:`, `settle:`, `create:`, `watch:`, `track:`, `purge:`) memakai satu alarm DO + tabel `timers`. Saat RideDO menyala, timer untuk pekerjaan yang masih menunggu Postgres dipasang ulang.

## API

REST (Bearer token):

| Endpoint | Keterangan |
|---|---|
| `POST /auth/login` | `{phone, role, name?}` → token. Belum ada OTP. |
| `GET /me` | user, kendaraan, saldo |
| `POST /rides/estimate` | jarak + tarif |
| `POST /rides` | buat ride (`Idempotency-Key`) |
| `GET /rides?mine=1` | riwayat; driver juga dapat pendapatan `today` |
| `GET /rides?active=1` · `GET /rides/:id` | ride aktif / satu ride |
| `POST /rides/:id/cancel` | batal (driver wajib isi alasan) |
| `POST /rides/:id/rating` | bintang 1–5, customer saja |
| `GET /wallet` · `POST /wallet/topup` · `GET /wallet/transactions` | saldo `{balance, held}`, top-up (`Idempotency-Key` wajib), riwayat |

Batas: `/auth/login` 20/menit per IP, `/ws` 30 koneksi/menit per user → 429.
Format error: `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }`.

WebSocket `GET /ws?token=…`

- Customer: `&rideId=` (atau kosong → ride aktif).
- Driver: `&lat=&lng=` (zona dari lokasi), `&zone=` setelah `zone.moved`, atau `&rideId=` saat sedang ride.
- `&known=1`: dikirim client di tiap reconnect setelah `hello` pertama, supaya gerbang tidak perlu query database.

Pesan dari client: `online`, `offline`, `loc`, `offer.accept`, `offer.reject`, `ride.arrived`, `ride.start`, `ride.complete`, `resume`, `ping`.
Pesan dari server: `hello`, `driver.state`, `offer`, `offer.cancelled`, `ride.status`, `ride.paid`, `driver.loc`, `zone.moved`, `pong`, `error`.
Definisi lengkap: `packages/client/src/protocol.ts`.

## Config (`apps/api/wrangler.jsonc`)

`ZONE_PRECISION` (≤ 5), `RIDE_SHARDS`, `COMMISSION_RATE`, `DRIVER_MIN_BALANCE`, `OFFER_TIMEOUT_MS`, `RESERVE_TTL_MS`,
`SEARCH_TIMEOUT_MS`, `RESEARCH_DELAY_MS`, `TOPUP_MAX`, `DRIVER_LOST_ASK_MS`, `DRIVER_LOST_CANCEL_MS`, `TRACK_FLUSH_MS`, `LOC_MIN_INTERVAL_MS`, `LOC_MIN_INTERVAL_ON_RIDE_MS`,
`LOC_MIN_MOVE_M`, `HANDOFF_MARGIN_M`, `HANDOFF_PINGS`, `TRACK_MIN_GAP_M`, `TRACK_MAX_GAP_MS`, `TRACK_TOLERANCE_M`. Secret: `JWT_SECRET`. Konstanta tarif: `packages/core/src/fare.ts`.

## Test

- `packages/core`: geohash, jarak, throttle ping, pindah zona, tarif, urutan kandidat, semua transisi status, pembayaran.
- `apps/api` (vitest di workerd + Postgres `gojek_test`): ride penuh, tolak → driver berikutnya, tawaran habis waktu, dua ride berebut satu driver, tidak ada driver, batal, pindah zona, saldo kurang, top-up & pembayaran tidak dobel, gangguan database.
- `apps/e2e` (Playwright): ride WALLET sampai rating, driver tolak, customer batal, driver reload di tengah ride, saldo kurang.

## Deploy

1. Buat Postgres (region Jakarta), jalankan `DATABASE_URL=<url> pnpm --filter @gojek/api db:migrate`.
2. `wrangler hyperdrive create gojek --connection-string=<url> --caching-disabled`, isi id-nya di `apps/api/wrangler.jsonc`.
3. `wrangler secret put JWT_SECRET`.
4. `pnpm --filter @gojek/api deploy`.

Cache Hyperdrive harus **mati**: saldo dan ride aktif tidak boleh terbaca basi. Jangan set `DEV_RESET` di produksi.

## Belum ada

OTP login, payment gateway & penarikan saldo driver, surge/promo, chat, KYC, panel admin.
Celah logic yang sudah diketahui ada di [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md); urutan kerjanya di [TODO.md](TODO.md).
