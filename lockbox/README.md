# QR Lockbox

A lockbox that unlocks when you scan a QR code. A Seeed XIAO ESP32-C3 on the
work WiFi serves an unlock endpoint; the QR code encodes that URL with a
secret key. Scanning it pulses a 12V solenoid latch via a relay for ~1 second.

- `WIRING.md` — bench wiring guide and test order (start here)
- `firmware/lockbox/lockbox.ino` — ESP32 firmware (Arduino IDE)

## Getting it running

1. Wire per `WIRING.md` (set the buck converter to 5.0V **before** connecting
   the XIAO).
2. In `lockbox.ino`, set your WiFi name/password and change `UNLOCK_KEY` to a
   long random string.
3. Arduino IDE → Boards Manager → install **esp32** (Espressif), select
   **XIAO_ESP32C3**, plug in via USB-C, upload.
4. Open the Serial Monitor (115200) — it prints the device IP and the exact
   URL the QR code should contain, e.g.
   `http://192.168.1.50/unlock?key=...`
5. Generate the QR code for that URL:
   ```sh
   npx qrcode -o lockbox-qr.png "http://<ip>/unlock?key=<your-key>"
   ```
   Print it and stick it wherever it lives.

Give the XIAO a fixed IP (DHCP reservation on the router) so the QR code
doesn't break when the lease changes; `http://lockbox.local/` also works on
phones that support mDNS.

## Endpoints

- `GET /` — status page (door open/closed via the reed switch)
- `GET /status` — JSON `{"door":"open"|"closed"}`
- `GET /unlock?key=SECRET` — fires the solenoid for 1s (3s cooldown)

Note: anyone on the same WiFi who has the QR code (or the URL) can unlock the
box — the secret key is the whole lock. Keep the printed QR somewhere only
the right people can scan it, and change the key in the firmware if it leaks.
