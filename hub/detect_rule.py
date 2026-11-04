"""Layer 1: robust rolling-median rule. Guarantees the demo works.

Flag a second when
    robust z = (watts - median) / (1.4826 * MAD) > Z_MIN
and watts - median > FLOOR_W.
The absolute floor stops idle-noise false alarms when MAD is near zero.

The baseline is the last WINDOW_S unflagged readings (120 s at one reading per
second), counted rather than timed: a kettle running for two minutes neither drags
the median up nor ages the baseline out, so it cannot end its own event early.
A load that stays on longer than ADOPT_MS is accepted as the new normal.
"""

from collections import deque

import numpy as np

WINDOW_S = 120
Z_MIN = 6.0
FLOOR_W = 200.0
MIN_SAMPLES = 20
ADOPT_MS = 600_000
MAD_FLOOR_W = 1.0


class RuleDetector:
    method = "rule"

    def __init__(self, window_s=WINDOW_S, z_min=Z_MIN, floor_w=FLOOR_W):
        self.window_s = window_s
        self.z_min = z_min
        self.floor_w = floor_w
        self.window = deque(maxlen=window_s)  # (ts, watts) of unflagged seconds
        self.flagged = deque()                # (ts, watts) of the current flagged run

    def step(self, ts, watts):
        """Return (flagged, score, baseline_w) for one reading."""
        if len(self.window) < MIN_SAMPLES:
            self.window.append((ts, watts))
            return False, 0.0, None

        w = np.fromiter((x[1] for x in self.window), float, len(self.window))
        median = float(np.median(w))
        mad = max(float(np.median(np.abs(w - median))), MAD_FLOOR_W)
        z = (watts - median) / (1.4826 * mad)
        flagged = z > self.z_min and watts - median > self.floor_w

        if flagged:
            self.flagged.append((ts, watts))
            if ts - self.flagged[0][0] > ADOPT_MS:
                # Sustained new level: adopt the recent run as the baseline.
                self.window = deque(self.flagged, maxlen=self.window_s)
                self.flagged.clear()
        else:
            self.flagged.clear()
            self.window.append((ts, watts))

        return flagged, float(z), median
