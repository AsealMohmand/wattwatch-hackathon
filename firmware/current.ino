// WattWatch firmware Step A: minimal serial node (Arduino Nano ESP32)
// Reads 1-2 ADS1115 boards on data-ready interrupts, computes 1 s RMS current,
// and prints one JSON line per port per second over USB serial (115200 baud).
// No Wi-Fi. Read by the hub with `python run_all.py --serial COM4`.
//
// Wiring per port (see README.md):
//   ADS1115 VDD -> 3.3V, GND -> GND, SDA -> A4, SCL -> A5
//   ch0 board: ADDR -> GND (0x48), ALRT -> D2
//   ch1 board: ADDR -> VDD (0x49), ALRT -> D3
//   Clamp jack: sleeve -> bias node (~1.65 V) and A1, tip -> A0
// Tools > Pin Numbering must be "By Arduino pin (default)".
// Libraries: Adafruit ADS1X15.

#include <Wire.h>
#include <Adafruit_ADS1X15.h>

const char* DEVICE_ID = "ww-01";
const char* FW_VERSION = "0.1.1-a";
const float CT_RATIO = 30.0;   // SCT-013-030: 30 A per 1 V
const float LIMIT_A = 13.0;    // absolute safety limit, raw amps
const uint32_t WINDOW_MS = 1000;
const uint8_t DISCARD_FIRST = 2;

struct Port {
  const char* name;
  uint8_t addr;
  uint8_t alrtPin;
  Adafruit_ADS1115 ads;
  bool present = false;
  volatile bool ready = false;
  uint8_t discard = DISCARD_FIRST;
  double sum = 0, sumSq = 0;
  float peak = 0;
  uint32_t n = 0;

  Port(const char* nm, int a, int pin) : name(nm), addr(a), alrtPin(pin) {}
};

Port ports[2] = {
  {"ch0", 0x48, D2},
  {"ch1", 0x49, D3},
};

char bootId[9];
uint32_t windowStart = 0;

void IRAM_ATTR onReady0() { ports[0].ready = true; }
void IRAM_ATTR onReady1() { ports[1].ready = true; }

void setRgb(bool r, bool g, bool b) {
  // RGB LED is active-low: LOW turns a color on.
  digitalWrite(LED_RED, r ? LOW : HIGH);
  digitalWrite(LED_GREEN, g ? LOW : HIGH);
  digitalWrite(LED_BLUE, b ? LOW : HIGH);
}

bool startPort(Port& p, void (*isr)()) {
  if (!p.ads.begin(p.addr, &Wire)) return false;
  p.ads.setGain(GAIN_FOUR);                 // +/-1.024 V full scale
  p.ads.setDataRate(RATE_ADS1115_860SPS);
  pinMode(p.alrtPin, INPUT_PULLUP);         // ALRT/RDY is open-drain
  attachInterrupt(digitalPinToInterrupt(p.alrtPin), isr, FALLING);
  // Continuous differential A0 - A1; the library also puts ALRT into conversion-ready mode.
  p.ads.startADCReading(ADS1X15_REG_CONFIG_MUX_DIFF_0_1, /*continuous=*/true);
  return true;
}

void printWindow(Port& p, uint32_t nowMs) {
  float irms = 0;
  if (p.n > 0) {
    double mean = p.sum / p.n;
    double var = p.sumSq / p.n - mean * mean;  // removes any small DC offset
    irms = var > 0 ? sqrt(var) : 0;
  }
  bool overLimit = irms > LIMIT_A;
  Serial.printf(
    "{\"device_id\":\"%s\",\"port\":\"%s\",\"boot_id\":\"%s\",\"uptime_ms\":%lu,"
    "\"ts\":null,\"irms_raw_a\":%.4f,\"peak_raw_a\":%.4f,\"n_samples\":%lu,"
    "\"over_ceiling\":false,\"over_limit\":%s,\"fw\":\"%s\"}\n",
    DEVICE_ID, p.name, bootId, (unsigned long)nowMs, irms, p.peak,
    (unsigned long)p.n, overLimit ? "true" : "false", FW_VERSION);
  p.sum = p.sumSq = 0;
  p.peak = 0;
  p.n = 0;
}

void setup() {
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  setRgb(false, false, true);  // blue = starting

  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) {}

  snprintf(bootId, sizeof(bootId), "%08lx", (unsigned long)esp_random());

  Wire.begin();
  Wire.setClock(400000);

  ports[0].present = startPort(ports[0], onReady0);
  ports[1].present = startPort(ports[1], onReady1);
  for (Port& p : ports) {
    Serial.printf("# %s (0x%02X): %s\n", p.name, p.addr, p.present ? "found" : "not found");
  }
  if (!ports[0].present && !ports[1].present) {
    setRgb(true, false, false);  // red = no ADC found; check wiring
    Serial.println("# No ADS1115 found. Check 3.3V, GND, SDA->A4, SCL->A5 and ADDR.");
    while (true) delay(1000);
  }
  setRgb(false, true, false);  // green = running
  windowStart = millis();
}

void loop() {
  for (Port& p : ports) {
    if (!p.present || !p.ready) continue;
    p.ready = false;
    int16_t raw = p.ads.getLastConversionResults();
    if (p.discard > 0) { p.discard--; continue; }
    float amps = p.ads.computeVolts(raw) * CT_RATIO;
    p.sum += amps;
    p.sumSq += (double)amps * amps;
    if (fabs(amps) > p.peak) p.peak = fabs(amps);
    p.n++;
  }

  uint32_t now = millis();
  if (now - windowStart >= WINDOW_MS) {
    windowStart += WINDOW_MS;
    for (Port& p : ports) {
      if (p.present) printWindow(p, now);
    }
  }
}