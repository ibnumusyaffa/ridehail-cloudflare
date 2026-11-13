# PLAN — Ride-Hailing POC (Gojek/Uber clone)

POC untuk rekrutmen. Dua role (Customer, Driver), dua sisi (Android + Backend).
Dokumen ini sengaja **platform-agnostic**: logika & kontrak didefinisikan sekali,
lalu bisa diimplementasikan di Cloudflare (Workers + Durable Objects), Rust, Go, atau Bun.

---

## 1. Scope POC

**Masuk scope**
- Customer pesan ride: pilih titik jemput & tujuan, lihat estimasi tarif.
- Sistem otomatis cari driver terdekat yang available, kirim tawaran, fallback ke driver berikutnya.
- Driver terima/tolak tawaran.
- Tracking posisi driver real-time di peta (customer & driver).
- Alur perjalanan sampai selesai + riwayat.
- Simulator driver palsu untuk demo dengan 1 HP.
- Pembayaran **Cash** atau **Wallet** (saldo internal sederhana, top-up dummy).

**Di luar scope (sebut di README sebagai "next step")**
- Payment gateway asli (top-up via VA/QRIS/kartu), withdraw driver ke rekening bank.
- Surge pricing, promo, multi-layanan (food, send).
- Chat customer–driver, panggilan telepon.
- Verifikasi KTP/SIM, onboarding driver lengkap.
- Batch matching / optimasi global.

---

## 2. Fitur Dasar

### 2.1 Customer
| # | Fitur | Keterangan |
|---|---|---|
| C1 | Login | Nomor HP / username sederhana → token. POC boleh tanpa OTP. |
| C2 | Pilih titik jemput | Default lokasi GPS sekarang, bisa geser pin di peta. |
| C3 | Pilih tujuan | Geser pin / cari alamat (geocoding opsional). |
| C4 | Estimasi tarif & jarak | Tampil sebelum konfirmasi. Harga **fixed upfront** (tarif final = estimasi). |
| C4a | Pilih metode bayar | Cash / Wallet. Wallet ditolak jika saldo < tarif. |
| C5 | Pesan ride | Kirim request → status "Mencari driver…". |
| C6 | Batalkan | Boleh selama belum dijemput (aturan detail di §4). |
| C7 | Lihat driver ditemukan | Nama, plat, kendaraan, jarak/ETA. |
| C8 | Tracking driver | Marker driver bergerak di peta (menuju jemput, lalu menuju tujuan). |
| C9 | Status perjalanan | Driver menuju → driver tiba → dalam perjalanan → selesai. |
| C10 | Ringkasan & rating | Tarif akhir, rating 1–5 (opsional). |
| C11 | Riwayat ride | List ride sebelumnya. |
| C12 | Wallet | Lihat saldo, top-up dummy, riwayat transaksi. |

### 2.2 Driver
| # | Fitur | Keterangan |
|---|---|---|
| D1 | Login | Sama seperti customer, role = driver. |
| D2 | Toggle Online/Offline | Hanya driver online yang ikut matching. |
| D3 | Kirim lokasi berkala | Tiap ~5 detik atau saat bergerak > 30 m. |
| D4 | Terima tawaran | Popup: titik jemput, tujuan, jarak, tarif, countdown 15 detik. |
| D5 | Terima / Tolak | Tolak atau timeout → tawaran pindah ke driver lain. |
| D6 | Navigasi ke jemput | Peta + rute ke titik jemput. |
| D7 | Tandai "Sudah tiba" | Notifikasi ke customer. |
| D8 | Mulai perjalanan | Setelah customer naik. |
| D9 | Selesaikan perjalanan | Tarif final, driver kembali available. |
| D10 | Batalkan (terbatas) | Sebelum jemput, dengan alasan. |
| D11 | Riwayat & pendapatan | List ride + total hari ini. |
| D12 | Wallet driver | Saldo pendapatan (dari ride wallet) dikurangi komisi (dari ride cash), riwayat transaksi. |

### 2.3 Sistem (backend)
| # | Fitur | Keterangan |
|---|---|---|
| S1 | Auth & role | Token berisi `userId` + `role`. |
| S2 | Geo index driver | Simpan posisi driver online di memori, terindeks per zona. |
| S3 | Matching otomatis | Cari driver terdekat available, kirim tawaran berurutan. |
| S4 | Reservasi atomik | Satu driver tidak bisa dapat dua ride bersamaan. |
| S5 | Timeout tawaran | 15 detik, lalu lanjut ke kandidat berikutnya. |
| S6 | State machine ride | Transisi valid saja (§4). |
| S7 | Push real-time | Status & lokasi driver ke customer via WebSocket. |
| S8 | Hitung tarif | Base + per km (+ per menit opsional). |
| S9 | Persistensi | User, ride, riwayat. Ping lokasi **tidak** dipersist. |
| S10 | Recovery | Client reconnect otomatis & kirim ulang state setelah putus/deploy. |
| S11 | Wallet & settlement | Ledger saldo, potong saldo customer & bagi hasil saat ride selesai, atomik & idempotent (§6). |

---

## 3. Alur End-to-End

```
CUSTOMER                         SISTEM                              DRIVER
   |                               |                                    |
   |                               |<-- online + ping lokasi (tiap 5s) -|
   |-- pilih jemput & tujuan       |                                    |
   |-- minta estimasi ------------>| hitung jarak & tarif               |
   |<-- tarif, jarak --------------|                                    |
   |-- pesan ride ---------------->| ride = REQUESTED                   |
   |                               | cari kandidat terdekat (k=10)      |
   |                               | reservasi kandidat #1              |
   |                               |-- tawaran (15s) ------------------>|
   |<-- "mencari driver" ----------|                                    |
   |                               |<-- tolak / timeout ----------------|
   |                               | lepas reservasi, kandidat #2 ...   |
   |                               |-- tawaran ------------------------>|
   |                               |<-- terima -------------------------|
   |<-- driver ditemukan ----------| ride = ACCEPTED                    |
   |<== lokasi driver (stream) ====|<== ping lokasi ====================|
   |<-- driver tiba ---------------|<-- "sudah tiba" -------------------|
   |<-- perjalanan dimulai --------|<-- "mulai" ------------------------|
   |<== lokasi driver (stream) ====|<== ping lokasi ====================|
   |<-- selesai + tarif -----------|<-- "selesai" ----------------------| driver available lagi
   |-- rating -------------------->| simpan ke DB                       |
```

---

## 4. State Machine Ride

```
REQUESTED ──(kandidat direservasi)──► OFFERING ──(driver terima)──► ACCEPTED
    │                                    │  ▲                            │
    │                                    │  └─(tolak/timeout, ada kandidat lain)
    │                                    └─(kandidat habis)──► NO_DRIVER
    │                                                                    ▼
    └──(customer batal)──► CANCELLED ◄──(batal sebelum jemput)── ARRIVED ◄─(driver tiba)
                                                                         │
                                                         (mulai)         ▼
                                                                    ON_TRIP ──(selesai)──► COMPLETED
```

| Dari | Event | Ke | Siapa |
|---|---|---|---|
| REQUESTED | kandidat ditemukan & direservasi | OFFERING | sistem |
| REQUESTED | tidak ada kandidat | NO_DRIVER | sistem |
| OFFERING | driver terima | ACCEPTED | driver |
| OFFERING | tolak / timeout, ada kandidat lain | OFFERING (driver berikutnya) | sistem |
| OFFERING | kandidat habis / batas waktu total (mis. 2 menit) | NO_DRIVER | sistem |
| REQUESTED/OFFERING/ACCEPTED/ARRIVED | batal | CANCELLED | customer / driver |
| ACCEPTED | driver tiba | ARRIVED | driver |
| ARRIVED | mulai perjalanan | ON_TRIP | driver |
| ON_TRIP | selesai | COMPLETED | driver |

Aturan:
- Transisi lain ditolak (error `INVALID_TRANSITION`).
- Setiap transisi bersifat **idempotent** (event dobel tidak merusak state).
- Status driver: `OFFLINE`, `AVAILABLE`, `RESERVED` (sedang ditawari), `ON_RIDE`.

---

## 5. Algoritma Matching (agnostic)

### 5.1 Geo index
- Bumi dibagi ke sel **geohash**. Presisi zona dapat dikonfigurasi (`ZONE_PRECISION`).
- Tiap zona menyimpan `Map<driverId, {lat, lng, status, updatedAt}>`.
- Driver dianggap stale & dikeluarkan bila tidak ping > 30 detik.

### 5.2 Mencari kandidat
1. Hitung sel pickup + 8 sel tetangga.
2. Ambil driver `AVAILABLE` dan tidak stale.
3. Urutkan dengan jarak **haversine** (opsional: ETA jalan via OSRM untuk top-N).
4. Jika kosong, perluas ring (radius berikutnya) sampai batas maks (mis. 5 km).
5. Ambil top `k` (mis. 10) sebagai antrean kandidat; skip driver yang sudah menolak ride ini.

### 5.3 Penawaran berurutan
1. `tryReserve(driver, rideId, ttl=20s)` — atomik, gagal jika driver tidak `AVAILABLE`.
2. Kirim tawaran ke driver, pasang timer 15 detik.
3. Terima → driver `ON_RIDE`, ride `ACCEPTED`.
4. Tolak/timeout → `release(driver)`, lanjut kandidat berikutnya.
5. Kandidat habis → cari ulang sekali (driver baru mungkin online), lalu `NO_DRIVER`.

### 5.4 Konsistensi
- Semua mutasi status driver di satu zona dilakukan oleh **satu pemilik** (single-writer / actor) → tanpa race condition.
- Reservasi lintas zona: minta ke pemilik zona driver tersebut (`tryReserve` via pesan/RPC).

### 5.5 Tarif
```
fare = max(MIN_FARE, BASE_FARE + PER_KM * distance_km)   // dibulatkan ke Rp 500
```
Konstanta di config. Jarak estimasi = haversine × 1.3 (atau jarak rute OSRM).
Harga fixed upfront: `fare_final = fare_estimate` (menyederhanakan pembayaran wallet).

---

## 6. Wallet & Pembayaran (sederhana)

### 6.1 Aturan
- Setiap user (customer & driver) punya satu wallet, mata uang IDR, nilai **integer rupiah** (tanpa float).
- Metode bayar dipilih saat pesan: `CASH` atau `WALLET`.
- `WALLET`: saldo dicek saat pesan (`saldo >= fare`), **dipotong saat ride COMPLETED**.
  Tidak ada hold/escrow di POC; jika saat selesai saldo kurang (jarang, mis. dipakai ride lain), ride tetap selesai dan sisa ditagih sebagai cash ke driver.
- Ride batal / NO_DRIVER → tidak ada transaksi.
- Komisi platform `COMMISSION_RATE` (config, mis. 20%; boleh 0 agar lebih simpel).
- Top-up customer di POC = endpoint dummy (langsung menambah saldo, batas mis. Rp 1.000.000/transaksi).

### 6.2 Settlement saat ride COMPLETED
| Metode | Customer wallet | Driver wallet | Uang fisik |
|---|---|---|---|
| WALLET | `− fare` | `+ fare × (1 − komisi)` | – |
| CASH | – | `− fare × komisi` (boleh minus) | customer bayar `fare` tunai ke driver |

Driver dengan saldo di bawah `DRIVER_MIN_BALANCE` (mis. −Rp 50.000) tidak bisa online sampai top-up.

### 6.3 Ledger
- Saldo disimpan di tabel `wallets`, setiap perubahan dicatat di `wallet_transactions` (append-only).
- Tipe transaksi: `TOPUP`, `RIDE_PAYMENT` (customer −), `RIDE_EARNING` (driver +), `COMMISSION` (driver −), `ADJUSTMENT`.
- Invariant: `wallets.balance == SUM(wallet_transactions.amount)` per wallet (dicek di test).

### 6.4 Konsistensi
- Settlement dalam **satu transaksi DB**: update saldo + insert ledger + set `rides.paid_at`.
- **Idempotent**: unique key `(ride_id, type)` pada ledger → settlement dobel (retry/event dobel) tidak memotong dua kali.
- Potong saldo pakai update bersyarat:
  `UPDATE wallets SET balance = balance - :fare WHERE user_id = :id AND balance >= :fare`
  (0 baris terpengaruh → saldo kurang → fallback cash seperti §6.1).
- Top-up memakai header `Idempotency-Key`.
- Wallet ada di **cold store** (strongly consistent), bukan di zone actor.

---

## 7. Arsitektur Logis

Komponen didefinisikan sebagai **modul/peran**, bukan produk.

```
            ┌───────────────────────────────────────────┐
Android ───►│ API Gateway  (HTTP REST + WebSocket upgrade)│
            └──────┬───────────────┬────────────────────┘
                   │               │
             ┌─────▼────┐   ┌──────▼─────────┐
             │  Auth    │   │  Zone Actor(s) │  ← state real-time: driver, geo index,
             └──────────┘   │  (Dispatcher)  │    matching, tawaran, timer, socket
                            └──────┬─────────┘
                                   │
                            ┌──────▼─────────┐
                            │  Ride Service  │  ← state machine, tarif
                            └──────┬─────────┘
                                   │
                  ┌────────────────┼────────────────┐
           ┌──────▼─────┐  ┌───────▼──────┐  ┌──────▼──────┐
           │ Hot store  │  │ Cold store   │  │ Blob store  │
           │ (ride aktif│  │ (user, ride  │  │ (foto)      │
           │  per zona) │  │  history)    │  │             │
           └────────────┘  └──────────────┘  └─────────────┘
```

### 7.1 Core murni (dibagi semua platform)
Ditulis tanpa I/O, mudah di-test & dipindah:
- `geo`: geohash encode/neighbors, haversine.
- `matcher`: pilih kandidat dari daftar driver.
- `rideStateMachine`: `apply(state, event) -> state | error`.
- `fare`: hitung tarif.
- `settlement`: `settle(ride, commissionRate) -> [ledgerEntries]` (murni, tanpa DB).

### 7.2 Port (interface) yang diimplementasi per platform
```
LocationStore   upsert(driverId, latLng) / remove / nearest(latLng, radius, k)
DriverRegistry  tryReserve(driverId, rideId, ttl) / release / setStatus
RideRepo        create / get / update(transition) / listByUser
Timer           schedule(key, at) / cancel(key)
Notifier        sendToUser(userId, message)
WalletRepo      getBalance(userId) / topup(userId, amount, idemKey) /
                applySettlement(rideId, entries)   // satu transaksi, idempotent
                listTransactions(userId)
```

### 7.3 Pemetaan ke platform

| Peran | Cloudflare | Rust (VPS) | Go (VPS) | Bun (VPS) |
|---|---|---|---|---|
| API Gateway | Worker (Hono) | axum | net/http + chi | `Bun.serve` |
| Zone Actor | Durable Object per zona | tokio task + mpsc per zona | goroutine + channel per zona | proses per core, zona di-shard `hash(zone) % N` |
| WebSocket | DO + Hibernation API | axum ws | coder/websocket | `Bun.serve` websocket (pub/sub bawaan) |
| Timer | DO Alarm | `tokio::time::sleep` | `time.AfterFunc` | `setTimeout` |
| Hot store | DO SQLite | memori + SQLite | memori + SQLite | memori + `bun:sqlite` |
| Cold store | D1 | SQLite → Postgres | SQLite → Postgres | SQLite → Postgres (`Bun.sql`) |
| Wallet (transaksi atomik) | D1 `batch()` (atomik) | SQLite/Postgres transaction | SQLite/Postgres transaction | `bun:sqlite` / `Bun.sql` transaction |
| Blob store | R2 | R2 / S3 | R2 / S3 | R2 / S3 |
| Scale-out | tambah zona (presisi) | Redis GEO + node stateless | Redis GEO + node stateless | Redis GEO + node stateless |

### 7.4 Prinsip desain (berlaku semua platform)
- Ping lokasi = **soft state** di memori, tidak ditulis ke DB.
- Satu pemilik per zona (actor) → konsistensi tanpa lock global.
- Zona diukur berdasarkan **kapasitas** (~1–3k driver/zona), bukan luas.
- Socket customer yang sedang ride dilayani oleh zona driver-nya (hindari actor tambahan per ride yang selalu bangun).
- Client wajib reconnect + kirim `resume` setelah putus.

---

## 8. Data Model (cold store)

```sql
users (
  id TEXT PK, role TEXT CHECK(role IN ('customer','driver')),
  name TEXT, phone TEXT UNIQUE, created_at INTEGER
)
vehicles (
  driver_id TEXT PK REFERENCES users(id), plate TEXT, model TEXT, color TEXT
)
rides (
  id TEXT PK, customer_id TEXT, driver_id TEXT NULL,
  pickup_lat REAL, pickup_lng REAL, pickup_label TEXT,
  drop_lat REAL, drop_lng REAL, drop_label TEXT,
  status TEXT, fare_estimate INTEGER, fare_final INTEGER, distance_m INTEGER,
  payment_method TEXT CHECK(payment_method IN ('CASH','WALLET')),
  paid_via TEXT NULL,            -- metode efektif (WALLET bisa fallback ke CASH)
  paid_at INTEGER NULL,
  cancel_reason TEXT NULL, rating INTEGER NULL,
  requested_at INTEGER, accepted_at INTEGER, arrived_at INTEGER,
  started_at INTEGER, completed_at INTEGER, cancelled_at INTEGER
)
INDEX rides(customer_id, requested_at DESC)
INDEX rides(driver_id, requested_at DESC)

wallets (
  user_id TEXT PK REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0,   -- rupiah
  updated_at INTEGER
)
wallet_transactions (
  id TEXT PK, user_id TEXT REFERENCES users(id),
  type TEXT CHECK(type IN ('TOPUP','RIDE_PAYMENT','RIDE_EARNING','COMMISSION','ADJUSTMENT')),
  amount INTEGER NOT NULL,              -- + masuk, − keluar
  balance_after INTEGER NOT NULL,
  ride_id TEXT NULL, idempotency_key TEXT NULL,
  created_at INTEGER,
  UNIQUE(ride_id, user_id, type),
  UNIQUE(user_id, idempotency_key)
)
INDEX wallet_transactions(user_id, created_at DESC)
```

---

## 9. Kontrak API

### 9.1 REST
| Method | Path | Role | Body / Respon |
|---|---|---|---|
| POST | `/auth/login` | - | `{phone, role}` → `{token, user}` |
| GET | `/me` | semua | profil |
| POST | `/rides/estimate` | customer | `{pickup, dropoff}` → `{distanceM, fare}` |
| POST | `/rides` | customer | `{pickup, dropoff, paymentMethod}` + header `Idempotency-Key` → `{rideId, status}` |
| GET | `/rides/:id` | pemilik | detail ride |
| POST | `/rides/:id/cancel` | customer/driver | `{reason}` |
| POST | `/rides/:id/rating` | customer | `{stars}` |
| GET | `/rides?mine=1` | semua | riwayat |
| GET | `/wallet` | semua | `{balance}` |
| POST | `/wallet/topup` | customer, driver | `{amount}` + header `Idempotency-Key` → `{balance}` (dummy) |
| GET | `/wallet/transactions` | semua | riwayat transaksi |

### 9.2 WebSocket `/ws?token=...`
Format pesan: `{ "t": "<type>", ...payload }`

**Client → Server**
| t | Dari | Payload |
|---|---|---|
| `online` / `offline` | driver | – |
| `loc` | driver | `{lat, lng, heading?, speed?}` |
| `offer.accept` / `offer.reject` | driver | `{rideId}` |
| `ride.arrived` / `ride.start` / `ride.complete` | driver | `{rideId}` |
| `resume` | semua | `{rideId?}` setelah reconnect |
| `ping` | semua | keepalive |

**Server → Client**
| t | Ke | Payload |
|---|---|---|
| `offer` | driver | `{rideId, pickup, dropoff, fare, distanceM, expiresAt}` |
| `offer.cancelled` | driver | `{rideId}` (timeout / customer batal) |
| `ride.status` | customer & driver | `{rideId, status, driver?, at}` |
| `ride.paid` | customer & driver | `{rideId, paidVia, fare, balance}` (setelah COMPLETED) |
| `driver.loc` | customer | `{rideId, lat, lng, heading}` |
| `error` | semua | `{code, message}` |

Kode error: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_TRANSITION`, `RIDE_NOT_FOUND`, `DRIVER_BUSY`, `OFFER_EXPIRED`, `INSUFFICIENT_BALANCE`, `DRIVER_BALANCE_TOO_LOW`.

---

## 10. Aplikasi Android

**Stack**: Kotlin + Jetpack Compose, satu app dengan pilihan role saat login.
Peta: MapLibre / osmdroid (OSM, tanpa API key) — atau Google Maps SDK.
Lokasi: `FusedLocationProviderClient`; driver pakai Foreground Service agar ping tetap jalan.
Jaringan: Retrofit/Ktor (REST) + OkHttp WebSocket dengan auto-reconnect (exponential backoff).

| Layar | Role | Isi |
|---|---|---|
| Login | semua | input HP + pilih role |
| Home Customer | customer | peta, pin jemput & tujuan, tombol estimasi |
| Konfirmasi | customer | jarak, tarif, pilih Cash/Wallet (tampil saldo), tombol Pesan |
| Mencari Driver | customer | animasi + tombol Batal |
| Ride Aktif | customer | peta + marker driver, info driver, status |
| Selesai | customer | tarif, rating |
| Home Driver | driver | toggle Online, peta posisi sendiri |
| Tawaran | driver | dialog countdown, Terima/Tolak |
| Ride Aktif | driver | peta rute, tombol Tiba → Mulai → Selesai |
| Riwayat | semua | list ride |
| Wallet | semua | saldo, tombol Top-up (dummy), riwayat transaksi |

---

## 11. Simulator & Demo
- CLI `sim`: spawn N driver palsu (default 50) di area Jakarta, login, online, bergerak acak/ikut rute, auto-accept tawaran dengan probabilitas tertentu (mis. 70%).
- Bisa jalan sebagai skrip terpisah (semua platform) atau internal (alarm/timer) agar hemat request.
- Skenario demo: 1 HP customer + 50 driver palsu, atau 2 HP (customer & driver asli) + driver palsu.

---

## 12. Testing
- **Unit (core murni)**: geohash neighbors, haversine, urutan kandidat, skip driver sibuk/menolak, state machine (semua transisi valid & invalid), tarif, settlement (cash vs wallet, komisi, pembulatan).
- **Wallet**: settlement dobel tidak memotong dua kali; saldo kurang → fallback cash; invariant saldo == jumlah ledger; top-up dengan idempotency key sama hanya sekali.
- **Integrasi**: alur penuh request → offer → timeout → offer berikutnya → accept → complete; dua ride rebutan satu driver (hanya satu yang menang); reconnect di tengah ride.
- **Load ringan**: simulator 1k driver, ukur memori & latensi matching.

---

## 13. Milestone

| # | Milestone | Hasil |
|---|---|---|
| M0 | Pilih platform backend | keputusan + skeleton repo |
| M1 | Core murni + unit test | `geo`, `matcher`, `rideStateMachine`, `fare`, `settlement` |
| M2 | Backend: auth, REST, WebSocket, zone actor, matching | alur ride lengkap via simulator |
| M2a | Wallet: saldo, top-up dummy, settlement saat COMPLETED | bayar cash/wallet jalan |
| M3 | Simulator driver | demo tanpa HP driver |
| M4 | Android: login, customer flow | pesan ride & tracking |
| M5 | Android: driver flow | terima tawaran & selesaikan ride |
| M6 | Polish | README, diagram arsitektur, angka memori/biaya, video demo |

---

## 14. Keputusan Terbuka
- Platform backend: Cloudflare (DO) / Rust / Go / Bun.
- Peta: MapLibre (OSM) vs Google Maps SDK.
- Jarak: haversine × faktor vs rute OSRM.
- Auth: tanpa OTP (POC) vs OTP (WhatsApp/Firebase).
- Rating & riwayat pendapatan driver: masuk M6 atau di-skip.
- Komisi platform: 20% atau 0% (paling simpel).
- Wallet: tanpa hold (POC) vs hold saldo saat ACCEPTED (lebih aman, lebih kompleks).
