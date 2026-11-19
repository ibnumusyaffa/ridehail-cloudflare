# API Ride-Hailing — Panduan Client Mobile

Dokumen ini untuk developer mobile (Android / iOS / Flutter / React Native) yang membangun aplikasi
**customer** dan **driver** di atas `apps/api`. Isinya: konsep, REST endpoint, protokol WebSocket,
alur lengkap tiap peran, error, dan jebakan yang perlu ditangani.

Sumber kebenaran tipe ada di kode, dokumen ini mengikutinya:

| Isi | File |
| --- | --- |
| Endpoint REST | [`apps/api/src/index.ts`](src/index.ts) |
| Tipe pesan WebSocket, `RideView` | [`packages/client/src/protocol.ts`](../../packages/client/src/protocol.ts) |
| Client REST referensi (TypeScript) | [`packages/client/src/api.ts`](../../packages/client/src/api.ts) |
| Client WebSocket referensi (reconnect, `route`) | [`packages/client/src/socket.ts`](../../packages/client/src/socket.ts) |
| Status ride, error code, enum | [`packages/core/src/types.ts`](../../packages/core/src/types.ts), [`rideStateMachine.ts`](../../packages/core/src/rideStateMachine.ts) |
| Contoh app nyata | `apps/simulator-customer/src/App.tsx`, `apps/simulator-driver/src/App.tsx` |

Kalau ragu, porting `socket.ts` apa adanya ke bahasa mobile: perilakunya sudah teruji end-to-end.

---

## 1. Konsep dasar

- **Base URL**: lokal `http://localhost:8787` (`pnpm dev`). Dari emulator Android pakai `http://10.0.2.2:8787`,
  dari HP fisik pakai IP LAN mesin dev. WebSocket = base URL dengan `http` → `ws` (`https` → `wss`).
- **Dua peran**: `customer` dan `driver`. Satu nomor HP terikat ke satu peran.
- **Auth**: JWT Bearer, berlaku **30 hari**, tanpa refresh token. Dapat 401 → hapus token, kembali ke login.
- **Uang**: integer **rupiah** (tanpa desimal). **Waktu**: epoch **milidetik** (number).
- **Koordinat**: `{ lat, lng }` derajat desimal. `Place` = `{ lat, lng, label? }` (`label` maks 200 karakter).
- **Routing WebSocket diatur server**: server memberi string `route` yang tidak perlu dimengerti app.
  App cukup menyimpannya dan mengirimnya balik setiap connect (lihat §5.3). App tidak perlu tahu soal zona.
- **Ride id** berbentuk `<zona>[.<shard>]_<uuid>` (mis. `qqguw_3f2a…`). Perlakukan sebagai string opaque,
  jangan di-parse.
- **REST untuk perintah sekali jalan** (login, order, batal, rating, wallet). **WebSocket untuk semua yang
  real-time** (tawaran ke driver, status ride, posisi driver, aksi driver selama trip).

---

## 2. Model data

### User
```ts
{ id: string; role: "customer" | "driver"; name: string; phone: string }
```

### Vehicle (driver saja, dibuat otomatis saat driver pertama login)
```ts
{ plate: string; model: string; color: string }
```

### RideView — bentuk ride di REST maupun WebSocket
```ts
{
  id: string;
  status: RideStatus;
  customerId: string;
  driverId: string | null;
  driver: { id: string; name: string; vehicle: Vehicle | null } | null;
  pickup: Place;
  dropoff: Place;
  distanceM: number;          // estimasi jarak jalan (meter)
  fare: number;               // harga di depan (rupiah), tetap
  fareFinal: number | null;   // diisi saat COMPLETED (= fare)
  paymentMethod: "CASH" | "WALLET";
  paidVia: "CASH" | "WALLET" | null;  // WALLET bisa jatuh ke CASH kalau saldo kurang
  paidAt: number | null;
  cancelReason: string | null;
  cancelledBy: string | null;  // "customer" | "system"
  rating: number | null;       // 1..5
  requestedAt: number;
  acceptedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}
```

### WalletTx
```ts
{
  id: string;
  type: "TOPUP" | "RIDE_PAYMENT" | "RIDE_EARNING" | "COMMISSION" | "ADJUSTMENT";
  amount: number;        // + masuk, - keluar
  balanceAfter: number;
  rideId: string | null;
  createdAt: number;
}
```

### Status ride

```
                 ┌──────────── NO_DRIVER (tidak ada driver dalam 2 menit)
                 │
REQUESTED ──► OFFERING ──► ACCEPTED ──► ARRIVED ──► ON_TRIP ──► COMPLETED
   ▲              │            │            │           │
   │              │            └─────┬──────┘           │
   │              │                  │ driver batal     │ sistem (driver hilang)
   └──────────────┴── tawaran ditolak/kedaluwarsa       ▼
                      atau driver batal (REQUEUE)    CANCELLED
```

| Status | Arti | UI customer | UI driver |
| --- | --- | --- | --- |
| `REQUESTED` | Ride tercatat, sedang dicari driver | "Mencari driver…" | – |
| `OFFERING` | Sedang ditawarkan ke satu driver | "Mencari driver…" | (driver yang ditawari melihat `offer`) |
| `ACCEPTED` | Driver menerima, menuju titik jemput | Kartu driver + marker bergerak | Navigasi ke pickup |
| `ARRIVED` | Driver tiba di titik jemput | "Driver sudah sampai" | Tombol "Mulai trip" |
| `ON_TRIP` | Dalam perjalanan | Peta trip | Tombol "Selesai" |
| `COMPLETED` | Selesai, dibayar | Ringkasan + rating | Ringkasan pendapatan |
| `CANCELLED` | Dibatalkan | – | – |
| `NO_DRIVER` | Tidak ada driver | "Driver tidak ditemukan" | – |

- **Aktif**: `REQUESTED`, `OFFERING`, `ACCEPTED`, `ARRIVED`, `ON_TRIP`. **Final**: `COMPLETED`, `CANCELLED`, `NO_DRIVER`.
- Customer hanya boleh punya **satu ride aktif**.
- Customer boleh batal di `REQUESTED` s.d. `ARRIVED`. **Tidak bisa** saat `ON_TRIP`.
- Driver tidak pernah "membatalkan" ride: kalau driver batal sebelum trip, ride kembali ke `REQUESTED`
  dan dicari driver lain. Setelah 3 kali driver batal, sistem membatalkan ride (`cancelReason: "drivers_cancelled"`).

### Status driver

| Status | Arti |
| --- | --- |
| `OFFLINE` | Tidak menerima order |
| `AVAILABLE` | Online, bisa ditawari |
| `RESERVED` | Sedang ditawari satu order (menunggu terima/tolak) |
| `ON_RIDE` | Sedang menjalankan ride |

---

## 3. Format error

### REST
```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "balance 5000 < fare 12000" } }
```

| `code` | HTTP | Kapan |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Body / parameter tidak valid |
| `UNAUTHORIZED` | 401 | Token hilang / kedaluwarsa / tidak valid → logout |
| `INSUFFICIENT_BALANCE` | 402 | Order WALLET, saldo tersedia < tarif |
| `DRIVER_BALANCE_TOO_LOW` | 402 | Driver saldo di bawah batas minimum (default -50.000) |
| `FORBIDDEN` | 403 | Peran salah / ride bukan milik user / nomor HP terdaftar di peran lain |
| `RIDE_NOT_FOUND` | 404 | Ride tidak ada |
| `INVALID_TRANSITION` | 409 | Aksi tidak sah untuk status sekarang (mis. batal saat `ON_TRIP`) |
| `ACTIVE_RIDE_EXISTS` | 409 | Customer sudah punya ride aktif |
| `DRIVER_BUSY` | 409 | Driver sudah punya ride aktif |
| `OFFER_EXPIRED` | 409 | Tawaran sudah lewat / bukan untuk driver ini |
| `RATE_LIMITED` | 429 | Terlalu sering (login, reconnect) |
| `UNAVAILABLE` | 503 | Gangguan sementara → **retry** (dengan `Idempotency-Key` yang sama bila ada) |
| `INTERNAL` | 500 | Bug server → boleh retry |

### WebSocket
```json
{ "t": "error", "code": "OFFER_EXPIRED", "message": "OFFER_EXPIRED" }
```
Kode sama dengan tabel di atas. Error WebSocket tidak menutup koneksi; tampilkan toast lalu lanjut.

---

## 4. REST API

Semua endpoint selain `/health` dan `/auth/login` butuh header:
```
Authorization: Bearer <token>
Content-Type: application/json
```

### `GET /health`
`200 { "ok": true }`

### `POST /auth/login`
Login atau daftar otomatis (find-or-create by phone). Belum ada OTP.

```json
// request
{ "phone": "+6281234567890", "role": "customer", "name": "Budi" }
// 200
{ "token": "eyJ…", "user": { "id": "u_…", "role": "customer", "name": "Budi", "phone": "+6281234567890" } }
```
- `phone`: karakter selain digit dan `+` dibuang, panjang 6–20.
- `role`: `customer` | `driver`. Nomor yang sudah terdaftar di peran lain → `403 FORBIDDEN`.
- `name` opsional (maks 80), hanya dipakai saat user baru dibuat. Default `"Customer 7890"` / `"Driver 7890"`.
- Driver baru otomatis dapat kendaraan dan wallet saldo 0. Rate limit per IP.

### `GET /me`
```json
{ "user": { … }, "vehicle": { "plate": "B 1234 XYZ", "model": "…", "color": "…" } | null, "wallet": { "balance": 50000 } }
```
`vehicle` selalu `null` untuk customer. Panggil saat app dibuka untuk validasi token (401 → login).

### `POST /rides/estimate` (customer)
```json
// request
{ "pickup": { "lat": -6.2, "lng": 106.816, "label": "Monas" }, "dropoff": { "lat": -6.225, "lng": 106.8 } }
// 200
{ "distanceM": 4120, "fare": 15500 }
```
Tarif = `max(10.000, 5.000 + 2.500 × km)` dibulatkan ke atas ke kelipatan 500, `km` = jarak garis lurus × 1,3.
Harga ini **fixed**: `fare` saat order = `fareFinal` saat selesai.

### `POST /rides` (customer) — buat order
Header tambahan: `Idempotency-Key: <uuid>` (sangat dianjurkan, maks 100 karakter).
```json
// request
{ "pickup": { "lat": -6.2, "lng": 106.816, "label": "Monas" },
  "dropoff": { "lat": -6.225, "lng": 106.8, "label": "Senayan" },
  "paymentMethod": "WALLET" }   // "CASH" (default) | "WALLET"
// 201
{ "rideId": "qqguw_…", "status": "REQUESTED", "ride": { RideView } }
```
- WALLET: saldo **ditahan** (hold) sebesar `fare` saat order; dilepas kalau batal / tidak ada driver.
  Saldo tersedia kurang → `402 INSUFFICIENT_BALANCE`.
- Sudah ada ride aktif → `409 ACTIVE_RIDE_EXISTS`.
- **Idempotency**: buat satu UUID per "niat order" (simpan sampai order berhasil atau user mengubah
  pickup/dropoff/metode bayar). Kalau request timeout / 5xx / koneksi putus, **retry dengan key yang sama**:
  server mengembalikan ride yang sama, bukan membuat ride kedua atau `ACTIVE_RIDE_EXISTS`.
  Client referensi retry 3× (0,5 s, 1 s) hanya untuk error jaringan dan 5xx.
- Setelah 201: buka WebSocket customer (lihat §5) dengan `rideId` ini.

### `GET /rides?active=1`
```json
{ "ride": { RideView } | null }
```
Ride aktif user (customer atau driver). Panggil saat app dibuka untuk memulihkan layar ride.

### `GET /rides`
Riwayat 50 ride terakhir, terbaru dulu.
```json
// customer
{ "rides": [RideView, …] }
// driver
{ "rides": [RideView, …], "today": { "count": 7, "gross": 120000, "net": 96000 }, "commissionRate": 0.2 }
```
`today` = ride `COMPLETED` sejak 00:00 WIB. `net` = gross dikurangi komisi.

### `GET /rides/:id`
```json
{ "ride": { RideView } }                          // customer
{ "ride": { RideView }, "commissionRate": 0.2 }   // driver
```
Hanya customer / driver ride tersebut (`403` selain itu). Komisi driver = `round(fare × commissionRate)`.

### `POST /rides/:id/cancel`
```json
{ "reason": "Salah titik jemput" }   // wajib untuk driver, opsional untuk customer (maks 200)
// 200
{ "ride": { RideView } }
```
- **Customer**: status jadi `CANCELLED` (boleh sampai `ARRIVED`).
- **Driver** (sebelum `ON_TRIP`): ride dikembalikan ke pencarian (`status: "REQUESTED"`, driver dilepas).
  Retry yang sama aman (jawaban sama).
- Status tidak cocok → `409 INVALID_TRANSITION`. Ride baru saja dibuat dan belum siap → `409`, coba lagi sebentar.

### `POST /rides/:id/driver-lost` (customer)
Jawaban untuk pesan WS `ride.driver_lost` (driver tidak mengirim lokasi lama saat `ON_TRIP`).
```json
{ "action": "arrived" }   // "arrived" → ride COMPLETED & dibayar | "cancel" → CANCELLED tanpa bayar
// 200
{ "ride": { RideView } }
```

### `POST /rides/:id/rating` (customer)
```json
{ "stars": 5 }   // integer 1..5
// 200
{ "ok": true }
```
Hanya ride `COMPLETED` milik customer, sekali saja (selain itu `409 INVALID_TRANSITION`).

### `GET /wallet`
```json
{ "balance": 150000, "held": 15500 }
```
`held` = saldo yang ditahan untuk ride WALLET yang sedang berjalan. **Saldo tersedia = `balance - held`**.

### `POST /wallet/topup`
Header **wajib**: `Idempotency-Key: <uuid>`.
```json
{ "amount": 100000 }   // integer 1..1.000.000
// 200
{ "balance": 250000 }
```
Simulasi (belum ada payment gateway). Satu key = satu top-up; retry dengan key sama tidak menambah dua kali.
Driver juga bisa top-up (dipakai saat saldo minus karena komisi tunai).

### `GET /wallet/transactions`
```json
{ "transactions": [WalletTx, …] }   // 100 terakhir, terbaru dulu
```

### `POST /dev/reset` (dev saja)
Menghapus semua data. Hanya aktif kalau server jalan dengan `DEV_RESET=1`. Jangan dipanggil dari app produksi.

---

## 5. WebSocket

### 5.1 Koneksi

```
GET /ws?token=<jwt>&<parameter routing>
```
Token dikirim lewat query (WebSocket di banyak platform tidak bisa set header). Parameter routing:

| Parameter | Siapa | Arti |
| --- | --- | --- |
| `route` | semua | String dari `hello` / `reconnect` terakhir. Kirim **apa adanya** kalau punya |
| `rideId` | customer | Ride yang sedang ditampilkan (setelah `POST /rides`). Didahulukan dari `route` |
| `lat`, `lng` | driver | Posisi sekarang. **Selalu kirim** untuk driver |

Aturannya (sama dengan `RideSocket`):
1. Simpan `route` dari setiap `hello` dan `reconnect`.
2. Setiap connect, tambahkan `route=<route>` kalau punya. Jangan di-parse atau dibuat sendiri.
3. Driver selalu menambahkan `lat` & `lng` terbaru. Customer menambahkan `rideId` ride yang sedang ditonton.

Connect pertama tanpa `route`: server mencari sendiri tempat yang benar (ride aktif di database, atau zona
dari `lat`/`lng`). Connect berikutnya dengan `route` tidak perlu ke database, jadi lebih cepat.
Route basi atau tidak dikenali tidak membuat error: server mengoreksinya.

Customer **tanpa ride aktif tidak bisa** membuka socket (`400 no active ride`). Customer membuka socket
hanya selama ada ride (setelah `POST /rides`, atau saat app dibuka dan `GET /rides?active=1` mengembalikan ride).

Driver membuka socket selama app driver aktif (online maupun offline), karena status online diatur lewat socket.

Penolakan handshake (HTTP, sebelum upgrade):

| HTTP | Arti | Tindakan |
| --- | --- | --- |
| 401 | Token tidak valid | Logout |
| 400 | Driver tanpa lat/lng, atau customer tanpa ride aktif | Perbaiki parameter / jangan buka socket |
| 429 | Terlalu banyak reconnect | Backoff lebih lama |
| 426 | Bukan request WebSocket | Bug client |

Kebanyakan library WebSocket mobile tidak memberi tahu status HTTP saat handshake gagal. Trik simulator:
saat socket tertutup, panggil `GET /me`; kalau 401 → logout.

### 5.2 Format pesan

Semua pesan JSON dengan field diskriminator `t`.

**Client → server**

| `t` | Field | Siapa | Arti |
| --- | --- | --- | --- |
| `ping` | – | semua | Keepalive, kirim tiap **20 s**. Dijawab `pong` |
| `resume` | `rideId?` | semua | Minta state terbaru setelah `hello` |
| `loc` | `lat, lng, heading?, speed?` | driver | Posisi GPS |
| `online` | – | driver | Mulai menerima order |
| `offline` | – | driver | Berhenti menerima order (menolak tawaran yang sedang berjalan) |
| `offer.accept` | `rideId` | driver | Terima tawaran |
| `offer.reject` | `rideId` | driver | Tolak tawaran |
| `ride.arrived` | `rideId` | driver | Tiba di titik jemput (`ACCEPTED` → `ARRIVED`) |
| `ride.start` | `rideId` | driver | Mulai trip (`ARRIVED` → `ON_TRIP`) |
| `ride.complete` | `rideId` | driver | Selesai (`ON_TRIP` → `COMPLETED`) |

**Server → client**

| `t` | Field | Untuk | Arti |
| --- | --- | --- | --- |
| `hello` | `route, role, driverStatus?, rideId?` | semua | Pesan pertama setelah tersambung. Simpan `route` |
| `pong` | – | semua | Balasan `ping` |
| `driver.state` | `status, rideId` | driver | Status driver berubah |
| `offer` | `rideId, pickup, dropoff, fare, distanceM, paymentMethod, expiresAt` | driver | Tawaran order baru |
| `offer.cancelled` | `rideId, reason` | driver | Tawaran ditarik: `TIMEOUT` (kedaluwarsa) atau `CANCELLED` (customer batal) |
| `ride.status` | `rideId, status, driver, at, ride` | customer, driver | Status ride berubah; `ride` = `RideView` lengkap |
| `ride.paid` | `rideId, paidVia, fare, balance` | customer, driver | Pembayaran selesai; `balance` = saldo baru penerima |
| `driver.loc` | `rideId, lat, lng, heading` | customer | Posisi driver selama ride (`ACCEPTED`..`ON_TRIP`) |
| `ride.requeued` | `rideId, reason: "DRIVER_CANCELLED"` | customer | Driver batal, sedang dicari driver lain (`ride.status` REQUESTED menyusul) |
| `ride.driver_lost` | `rideId, lastSeenAt, autoCancelAt` | customer | Saat ON_TRIP driver tidak kirim lokasi ≥ 60 menit |
| `ride.driver_back` | `rideId` | customer | Driver kembali terhubung |
| `reconnect` | `route` (string atau `null`) | semua | **Tutup dan connect ulang** dengan `route` ini (lihat §5.3) |
| `error` | `code, message` | semua | Error untuk pesan yang dikirim client |

**Selalu pakai `ride.status.ride` sebagai state utuh** (replace, bukan merge). Abaikan `ride.status`
yang `rideId`-nya bukan ride yang sedang ditampilkan.

### 5.3 `reconnect` — wajib ditangani

Kadang server perlu memindahkan koneksi (driver menyeberang wilayah, menerima order, ride selesai).
App tidak perlu tahu alasannya. Server mengirim:

```json
{ "t": "reconnect", "route": "v1.r.qqguw" }
{ "t": "reconnect", "route": null }
```

Tindakan client:
1. Simpan `route = msg.route` (`null` artinya hapus route yang tersimpan).
2. **Tutup socket ini sendiri** (server kadang membiarkannya terbuka).
3. Connect ulang segera (~100 ms) dengan `route` baru (+ `lat`/`lng` untuk driver, + `rideId` untuk customer).
4. Setelah `hello` di socket baru, kirim `resume` seperti biasa.

`route` adalah string opaque. Isinya bisa berubah kapan saja tanpa pemberitahuan; jangan di-parse,
jangan dipakai untuk logika app, jangan ditampilkan ke user.

Pesan yang terkirim di sela perpindahan tetap diteruskan server, jadi tidak perlu antre manual —
tapi tombol aksi tetap harus menunggu konfirmasi `ride.status`.

### 5.4 Reconnect, keepalive, close code

- Keepalive: `{"t":"ping"}` tiap 20 s selama terbuka.
- Backoff: mulai 500 ms, ×2 tiap gagal, maks 10 s, dikali jitter acak 0,5–1,5. Reset ke 500 ms saat `open`.
- Close `1001`, `1006`, `1012` (deploy / restart server): tunda acak **0,5–5 s** sebelum reconnect
  pertama, supaya ribuan client tidak masuk bersamaan.
- Close code khusus:

| Code | Arti | Tindakan |
| --- | --- | --- |
| `4000` | Diganti koneksi lain user yang sama (mis. login di HP lain) | Boleh reconnect, tapi kalau berulang tanyakan user / berhenti |
| `4001` | Server memindahkan koneksi (`reconnect` sudah dikirim) | Connect ulang sesuai §5.3 (kalau `reconnect` tidak sempat terbaca, pakai `route` lama; server akan mengarahkan lagi) |
| `4002` | Data di-reset (dev) | **Jangan reconnect**, hapus sesi lokal, ke login |

- State routing di client hanya satu: `route` (dari `hello` dan `reconnect`). Simpan di memori; boleh juga
  di storage supaya connect setelah app dibuka ulang tidak perlu ke database.
- Saat app ke background lama / socket mati: setelah kembali, reconnect lalu `resume`. Untuk customer,
  sebaiknya juga `GET /rides?active=1` untuk memastikan.

---

## 6. Alur aplikasi customer

```
Login ─► GET /me ─► GET /rides?active=1 ─┬─ ada ride aktif ─► buka WS (rideId) ─► layar ride
                                         └─ tidak ada ──────► layar pilih lokasi
```

1. **Pilih lokasi**: ambil pickup (GPS) dan dropoff (search / pin). Geocoding & rute peta urusan client
   (simulator memakai Nominatim & OSRM publik; untuk produksi pakai provider sendiri).
2. **Estimasi**: `POST /rides/estimate` setiap pickup/dropoff berubah. Tampilkan jarak & tarif.
3. **Metode bayar**: CASH / WALLET. Untuk WALLET, tampilkan saldo tersedia (`GET /wallet`: `balance - held`).
4. **Order**: buat `Idempotency-Key` (UUID), `POST /rides`. Simpan `rideId`.
5. **Buka WebSocket** `?token=…&rideId=<rideId>`. Saat `hello` → kirim `{"t":"resume","rideId":"<rideId>"}`.
   Server membalas `ride.status` terkini.
6. **Menunggu driver** (`REQUESTED`/`OFFERING`): animasi mencari. Tombol batal → `POST /rides/:id/cancel`.
   Pencarian berhenti setelah **2 menit** → `ride.status` `NO_DRIVER` (saldo hold dilepas).
7. **Driver ditemukan** (`ACCEPTED`): tampilkan `ride.driver` (nama, plat, model, warna).
   Update marker dari `driver.loc` (bisa sampai 1×/detik). Customer masih bisa batal.
8. **Driver batal**: datang `ride.requeued` lalu `ride.status` `REQUESTED` → kembali ke layar mencari,
   hapus marker driver.
9. **`ARRIVED`** → notifikasi "driver sudah sampai". **`ON_TRIP`** → tombol batal disembunyikan.
10. **`COMPLETED`** → `ride.paid` menyusul dengan `paidVia` & saldo baru. `paidVia` bisa `CASH` walau
    order WALLET (saldo kurang saat settlement): tampilkan "bayar tunai ke driver".
11. **Rating**: `POST /rides/:id/rating`. Lalu tutup socket dan kembali ke layar awal.
12. **Driver hilang** (`ride.driver_lost`): tampilkan dialog "Sudah sampai?" / "Batalkan" →
    `POST /rides/:id/driver-lost`. Kalau tidak dijawab, sistem membatalkan di `autoCancelAt`.
    `ride.driver_back` → tutup dialog.

---

## 7. Alur aplikasi driver

```
Login ─► GET /me ─► buka WS (?lat&lng) ─► hello ─► loc ─► online ─► AVAILABLE
   ─► offer ─► offer.accept ─► ride.status ACCEPTED + reconnect(route) ─► connect ulang
   ─► ride.arrived ─► ride.start ─► ride.complete ─► ride.paid + driver.state + reconnect(route)
   ─► connect ulang ─► AVAILABLE lagi
```

1. **Buka WebSocket** `?token=…&lat=<lat>&lng=<lng>` (lat/lng wajib, 6 desimal cukup).
2. **Saat `hello`**:
   - Kirim `loc` posisi sekarang dulu.
   - `driverStatus` `ON_RIDE` atau `RESERVED` → kirim `{"t":"resume","rideId": hello.rideId}`
     (server membalas `driver.state`, `offer` yang masih berlaku, atau `ride.status`).
   - `driverStatus` `OFFLINE` dan driver memang ingin online → kirim `online`.
   - `driverStatus` `AVAILABLE` → tidak perlu kirim apa-apa (mis. setelah server memindahkan driver ke zona
     lain, status online ikut pindah).
   - Server bisa **lupa** status online kalau driver lama tidak terhubung (hello datang `OFFLINE`); karena itu
     simpan niat online di client.
3. **Online**: kirim `online` (harus sudah pernah `loc`, kalau tidak `BAD_REQUEST "send a loc first"`).
   Balasan `driver.state` `AVAILABLE`. Saldo di bawah minimum → `error DRIVER_BALANCE_TOO_LOW` → arahkan top-up.
4. **Kirim lokasi** (`loc`) terus selama socket terbuka, termasuk saat offline:
   - Kirim kalau sudah bergerak ≥ **30 m** atau sudah **10 s** sejak kirim terakhir (`shouldSendPing`).
   - Driver yang tidak mengirim lokasi > **45 s** dianggap tidak aktif dan tidak ditawari order.
   - Saat `ON_RIDE`, kirim lebih sering (server menerima sampai 1×/detik) agar marker customer mulus
     dan rute trip tercatat.
   - Sertakan `heading` (derajat 0–359) untuk rotasi ikon motor di peta customer.
5. **Tawaran** (`offer`): tampilkan pickup, dropoff, tarif, jarak, metode bayar, dan countdown ke
   `expiresAt` (default **15 s**). Status driver jadi `RESERVED`.
   - Terima → `{"t":"offer.accept","rideId":…}`. Tolak → `offer.reject`.
   - `offer.cancelled` → tutup kartu tawaran (`TIMEOUT` = kedaluwarsa, `CANCELLED` = customer batal).
   - Terima terlambat → `error OFFER_EXPIRED`. `error UNAVAILABLE` → boleh tekan terima lagi.
6. **Setelah terima**: datang `ride.status` `ACCEPTED` lalu `reconnect` → connect ulang
   (§5.3). Di socket baru `hello.driverStatus = "ON_RIDE"` → kirim `resume`.
7. **Selama ride**: tombol aksi kirim `ride.arrived`, `ride.start`, `ride.complete` (dengan `rideId`).
   Tunggu `ride.status` sebagai konfirmasi sebelum ganti layar. Mengirim ulang aksi yang sama aman (idempoten).
8. **Batal oleh driver** (sebelum `ON_TRIP`): `POST /rides/:id/cancel` dengan `reason` wajib. Driver dilepas
   (`driver.state` + `reconnect`).
9. **Selesai**: `ride.paid` (saldo driver baru), `driver.state` `AVAILABLE` (atau `OFFLINE` + `error
   DRIVER_BALANCE_TOO_LOW` kalau saldo jatuh di bawah minimum), lalu `reconnect` →
   connect ulang.
10. **Offline**: kirim `offline`. Saat `ON_RIDE` ditolak dengan `DRIVER_BUSY` ("finish the ride first").
11. **Riwayat & pendapatan**: `GET /rides` (`today.count/gross/net`), detail `GET /rides/:id`.

### Pembayaran dari sisi driver

| Metode | Customer | Driver |
| --- | --- | --- |
| `WALLET` | saldo − `fare` | saldo + (`fare` − komisi) |
| `CASH` | bayar tunai ke driver | saldo − komisi (driver menerima tunai `fare`) |

Komisi default 20%. Saldo driver bisa minus karena komisi tunai; di bawah **-50.000** driver tidak bisa online
sampai top-up.

---

## 8. Contoh sesi WebSocket

Driver (`→` client ke server, `←` server ke client):
```
CONNECT /ws?token=…&lat=-6.200000&lng=106.816000
← {"t":"hello","route":"v1.m.qqguw","role":"driver","driverStatus":"OFFLINE","rideId":null}
→ {"t":"loc","lat":-6.2,"lng":106.816,"heading":90}
→ {"t":"online"}
← {"t":"driver.state","status":"AVAILABLE","rideId":null}
← {"t":"offer","rideId":"qqguw_9c1…","pickup":{…},"dropoff":{…},"fare":15500,"distanceM":4120,"paymentMethod":"CASH","expiresAt":1763540000000}
→ {"t":"offer.accept","rideId":"qqguw_9c1…"}
← {"t":"ride.status","rideId":"qqguw_9c1…","status":"ACCEPTED","driver":{…},"at":…,"ride":{…}}
← {"t":"reconnect","route":"v1.r.qqguw"}
CLOSE, CONNECT /ws?token=…&route=v1.r.qqguw&lat=…&lng=…
← {"t":"hello","route":"v1.r.qqguw","role":"driver","driverStatus":"ON_RIDE","rideId":"qqguw_9c1…"}
→ {"t":"resume","rideId":"qqguw_9c1…"}
← {"t":"driver.state","status":"ON_RIDE","rideId":"qqguw_9c1…"}
← {"t":"ride.status",…,"status":"ACCEPTED",…}
→ {"t":"ride.arrived","rideId":"qqguw_9c1…"}
← {"t":"ride.status",…,"status":"ARRIVED",…}
→ {"t":"ride.start","rideId":"qqguw_9c1…"}
← {"t":"ride.status",…,"status":"ON_TRIP",…}
→ {"t":"ride.complete","rideId":"qqguw_9c1…"}
← {"t":"ride.status",…,"status":"COMPLETED",…}
← {"t":"ride.paid","rideId":"qqguw_9c1…","paidVia":"CASH","fare":15500,"balance":-3100}
← {"t":"driver.state","status":"AVAILABLE","rideId":null}
← {"t":"reconnect","route":"v1.m.qqguw"}
CLOSE, CONNECT /ws?token=…&route=v1.m.qqguw&lat=…&lng=…
```

Customer:
```
POST /rides  → 201 {"rideId":"qqguw_9c1…","status":"REQUESTED",…}
CONNECT /ws?token=…&rideId=qqguw_9c1…
← {"t":"hello","route":"v1.r.qqguw","role":"customer","rideId":"qqguw_9c1…"}
→ {"t":"resume","rideId":"qqguw_9c1…"}
← {"t":"ride.status",…,"status":"OFFERING",…}
← {"t":"ride.status",…,"status":"ACCEPTED","driver":{"id":"u_…","name":"Driver 1234","vehicle":{…}},…}
← {"t":"driver.loc","rideId":"qqguw_9c1…","lat":-6.2001,"lng":106.8161,"heading":90}
…
← {"t":"ride.status",…,"status":"COMPLETED",…}
← {"t":"ride.paid","rideId":"qqguw_9c1…","paidVia":"CASH","fare":15500,"balance":0}
```

---

## 9. Checklist implementasi & jebakan

- [ ] Simpan token aman (Keychain / EncryptedSharedPreferences). 401 di mana saja → logout.
- [ ] `Idempotency-Key` per niat order dan per top-up; retry pakai key yang sama.
- [ ] Port logika `RideSocket` (simpan & kirim balik `route`, tangani `reconnect`, backoff + jitter, keepalive, close 4002).
- [ ] Kirim `resume` di setiap `hello`. Jangan menganggap state lokal masih benar setelah reconnect.
- [ ] Layar dirender dari `ride.status.ride` terbaru, bukan dari asumsi urutan pesan.
- [ ] Tombol aksi driver: disable setelah ditekan, aktif lagi setelah `ride.status` atau `error`.
- [ ] Driver: kirim `loc` di background (foreground service Android / background location iOS);
      kalau berhenti > 45 s driver tidak dapat order, kalau > 60 menit saat trip customer diberi dialog driver hilang.
- [ ] Driver: simpan niat "online" lokal; kirim `online` setelah `hello` yang `driverStatus`-nya `OFFLINE`.
- [ ] Countdown tawaran pakai `expiresAt` dikurangi selisih jam server (jam HP bisa meleset; selisih dapat
      dihitung dari `ride.status.at` vs `Date.now()`).
- [ ] Customer: buka socket hanya saat ada ride aktif; tutup setelah status final + `ride.paid`.
- [ ] Tampilkan `paidVia` aktual, bukan `paymentMethod`.
- [ ] Belum ada: OTP, push notification (FCM/APNs), upload foto, chat customer–driver, rute/ETA dari server,
      pembatalan dengan biaya. Kalau app butuh notifikasi saat background, perlu ditambahkan di server.

## 10. Konfigurasi server yang memengaruhi UX

Default dari `apps/api/src/env.ts` (bisa diubah di `wrangler.jsonc` / `.dev.vars`):

| Variabel | Default | Efek |
| --- | --- | --- |
| `OFFER_TIMEOUT_MS` | 15 000 | Lama tawaran ke driver |
| `SEARCH_TIMEOUT_MS` | 120 000 | Lama pencarian sebelum `NO_DRIVER` |
| `MAX_REQUEUES` | 3 | Batas driver batal sebelum ride dibatalkan sistem |
| `COMMISSION_RATE` | 0.2 | Komisi platform |
| `DRIVER_MIN_BALANCE` | -50 000 | Saldo minimum driver untuk online |
| `TOPUP_MAX` | 1 000 000 | Maks satu top-up |
| `DRIVER_LOST_ASK_MS` | 3 600 000 | ON_TRIP tanpa lokasi → `ride.driver_lost` |
| `DRIVER_LOST_CANCEL_MS` | 10 800 000 | ON_TRIP tanpa lokasi → dibatalkan sistem |
| `LOC_MIN_INTERVAL_MS` | 8 000 | Ping driver bebas yang diterima server (lebih sering + tidak bergerak dibuang) |
| `LOC_MIN_INTERVAL_ON_RIDE_MS` | 1 000 | Sama, saat ON_RIDE |
| `CORS_ORIGINS` | `*` | Tidak relevan untuk app native |

Radius pencarian driver: 2 km dari pickup, ditawarkan satu per satu dari yang terdekat.
