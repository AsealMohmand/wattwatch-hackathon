# WattWatch firmware

Plug node for WattWatch: an Arduino Nano ESP32 with one or two ADS1115 ADCs reading a CT clamp on a line splitter. It computes RMS current on the node and sends one reading per port per second to the [hub](../hub) over USB serial.

## `current.ino`

The sketch flashed on the node (WattWatch Step A, firmware `0.1.1-a`). It reads each ADS1115 differentially at 860 samples/s on data-ready interrupts, computes a 1 s RMS with the mean removed, and prints one JSON line per port per second at 115200 baud:

```json
{"device_id":"ww-01","port":"ch0","boot_id":"1fdf7b78","uptime_ms":22996,"ts":null,"irms_raw_a":0.0805,"peak_raw_a":0.1209,"n_samples":861,"over_ceiling":false,"over_limit":false,"fw":"0.1.1-a"}
```

The hub reads this as is (`python run_all.py --serial COM4`):
- The device is `ww-01/ch0`.
- `irms_a = irms_raw_a × CT_CAL` and `watts = irms_a × 120`.
- `ts` is stamped on arrival, since the node has no NTP.
- `boot_id`, `uptime_ms`, `n_samples` and `peak_raw_a` feed the console's Nodes page (boots, uptime, sample rate, crest factor).

Lines starting `#` are boot diagnostics; the hub skips them. There is no Wi-Fi and the sketch holds no credentials.

## Wiring (per ADS1115)

| ADS1115 | Nano ESP32 |
|---|---|
| VDD | 3.3V |
| GND | GND |
| SDA | A4 |
| SCL | A5 |
| ADDR | GND for ch0 (0x48), VDD for ch1 (0x49) |
| ALRT | D2 for ch0, D3 for ch1 |
| A0, A1 | clamp jack tip to A0; sleeve to the ~1.65 V bias node and A1 |

The CT clamp is an SCT-013-030 (30 A per 1 V), on the line splitter's single conductor.

## Build and flash

1. Arduino IDE: install the **Arduino ESP32 Boards** core and the **Adafruit ADS1X15** library.
2. Open `current.ino`. The IDE offers to move it into a folder named `current`; accept.
3. Select board **Arduino Nano ESP32**, and set Tools > Pin Numbering to "By Arduino pin (default)". Upload.
4. The Serial Monitor at 115200 should show `# ch0 (0x48): found`, then one JSON line per second. Close the monitor before starting the hub: only one program can hold the port.

Calibrate by switching on a load of known wattage (a kettle's rating plate is close enough). Set `CT_CAL` on the hub to rated ÷ shown.

## Safety

The line splitter carries mains. Unplug it before touching anything on the node, and keep its enclosure closed while recording.
