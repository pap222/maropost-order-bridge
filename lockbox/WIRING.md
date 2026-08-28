# Lockbox — bench wiring guide

Parts (Core Electronics order #1000710228 + Jaycar wire/diodes):

| Part | Role |
|---|---|
| Seeed XIAO ESP32-C3 | Brains — WiFi + web unlock endpoint |
| 12V 2A plugpack + female barrel jack adapter | Power in |
| DC-DC step-down module (buck) | 12V → 5V for the XIAO + relay |
| 5V single-channel relay module | Switches 12V to the solenoid |
| Electric solenoid lock (FIT0620) | The latch |
| Magnetic contact (reed) switch (SEN0481) | Door open/closed sensing |
| 1N4004 diode | Flyback protection across the solenoid |
| Figure-8 wire (12V runs) + hookup wire (signals) | |

## STEP 0 — set the buck converter FIRST (important)

Before connecting the XIAO to anything:

1. Plug the barrel jack adapter into the plugpack, wire its `+` and `-`
   screw terminals to the buck module's **IN+ / IN-**.
2. Power on and measure the buck's **OUT+ / OUT-** with a multimeter.
3. Turn the little brass pot (usually many turns, counter-clockwise lowers it)
   until the output reads **5.0V**. These modules often ship at ~20V —
   connecting the XIAO before adjusting will kill it.
4. Power off.

## Wiring map

```
12V plugpack ── barrel jack adapter
                   │+12V ────────┬──────────────► relay COM
                   │             └► buck IN+
                   │GND ─────────┬► buck IN-
                                 ├► solenoid (-) wire
                                 └► common ground with 5V side (buck OUT-)

buck OUT+ (5.0V) ──┬► XIAO 5V pin
                   └► relay VCC
buck OUT-  ────────┬► XIAO GND
                   └► relay GND

XIAO D1 (GPIO3) ──► relay IN        (signal wire)
XIAO D2 (GPIO4) ──► reed switch leg A (signal wire)
reed switch leg B ► GND             (firmware uses internal pull-up)

relay NO ─────────► solenoid (+) wire
```

Use the **NO** (normally open) relay terminal, not NC — so the solenoid is
only powered during the unlock pulse.

## Flyback diode (the 1N4004)

Solder/twist it **directly across the two solenoid wires**:

- Banded end (cathode) → solenoid **+** wire (the one from relay NO)
- Plain end (anode) → solenoid **-** wire (GND)

Band toward positive. Backwards = dead short when the relay fires, so
double-check the band before powering on.

## Bench-test order

1. Buck set to 5.0V (step 0), power off.
2. Wire everything per the map. Screw terminals / twisted+taped joints are
   fine for the bench.
3. Power on with the XIAO **unflashed**: relay should stay off, solenoid
   bolt stays out (locked). XIAO LED lights up.
4. Flash the firmware (see `firmware/`), open the web page, hit unlock —
   relay clicks, solenoid bolt snaps in for ~1 second.
5. Hold the reed switch's magnet against the switch body and watch the
   status page flip between OPEN / CLOSED.

## Notes

- The FIT0620 solenoid is **intermittent duty** — ~1s pulses, never hold it
  energized more than ~10s. The firmware enforces a 1s pulse + cooldown.
- Most of these relay modules are **active-LOW** (relay ON when IN is pulled
  low). The firmware defaults to active-low; if your relay is on when it
  should be off, flip `RELAY_ACTIVE_LOW` in the sketch.
- When you move to the real (bigger) box: solenoid mounts inside so its bolt
  catches the lid/door, reed switch halves go on door + frame, everything
  else lives in the jiffy box.
