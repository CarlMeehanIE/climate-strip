# climate-strip

Personal apps for a BMW iDrive 8 head unit, installed through the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Id | What it does |
|---|---|---|
| Climate Strip | `mystrip_climate` | The seat and steering wheel heating as an ordinary app. Tap **Your seat (driver)** or **Passenger seat** to step that seat's heating up a stage (off after the highest), **Steering wheel** to turn it on or off. Each row shows the level the car reports (BMW's names: off, low, medium, high, very high) and the heater's stage. Seats are addressed as driver and passenger, so the driver's row is right on a right-hand-drive car. It also sends the Climate Bar's commands to the car, and its last rows turn the bar on or off and line its buttons up. Built by `node tools/make_strip.js`. |
| Climate Bar | `mystrip_bar` (a service) | The passenger's seat, driver's seat and steering wheel buttons drawn in the climate bar at the bottom of the screen, over BMW's own seat heating indicators, red while on with one heat line per stage. Needs Climate Strip (which talks to the car) and the Store's Renderer (`mgu-render` 0.6.10 or newer, whose overlay mode lets it draw and take touch in the climate bar). See **Climate Bar** below. |
| Signal Finder | `mystrip_finder` | Read-only. Reads the head unit's SOME/IP interface catalogue (`/etc/oap/someip/someip-interfaces.json`) and lists the interfaces with seat-heating or steering-wheel-heating parts. Tap an interface for its parts, each marked GET / SET / NOTIFY (fields), CALL (methods) or EVENT; tap a part for its data type spelled out and its raw catalogue entry. Sends nothing to the car. |
| Heat Watch Seats | `mystrip_watchseat` | Read-only. A live log of every value that changes on `de.bmw.infotainment.climate.Climate` while the car's own seat heating buttons are pressed (newest first; start values marked "start"). **Clear log** empties it. |
| Heat Watch Wheel | `mystrip_watchwheel` | The same for `de.bmw.body.steeringwheelcomfort.SteeringWheelClimate` and the steering wheel heating button. |
| Heat Watch Master | `mystrip_watchmaster` | The same for `de.bmw.infotainment.climate.climatemaster.ClimateMaster` (seat and steering wheel heating). |
| Heat Test | `mystrip_heattest` | **Sends commands**, one per button press: the driver's or passenger's seat to a level through `Climate.seatHeatingLamination` or `ClimateMaster.requestSeatClimateSeatHeating`, the steering wheel on / off through `SteeringWheelClimate.requestHeating` or to a level through `ClimateMaster.requestSteeringWheelHeating`. Logs what it sent and the car's answer, and shows the live levels. Built by `node tools/make_heattest.js`. |

Each Heat Watch app names its interface in its manifest, and the head unit
refuses an app whose interface its catalogue lacks, so they are separate
apps: one refused leaves the others. They are built from `tools/watch/src`
by `node tools/make_watch.js`.

iDrive 8 only. The head unit builds each app from this repository's source
(a source package, `"build": "unit"`), linking it against the BMW app SDK
already on the car, so no SDK is in this repository.

## Installing

1. In the Store, open **Sources**, **Add source**, and type this
   repository as `<your GitHub name>/climate-strip`. Pick its branch
   (`main`) if the Store asks for a channel.
2. Install **Signal Finder** and the **Heat Watch** apps, then restart the head unit once when the
   Store asks (on iDrive 8 an app installs at the next start).
3. Open **Signal Finder** from *All apps*. It reads the catalogue by
   itself when it opens (a few seconds).

To remove it: the Store's app list, **Signal Finder**, **Remove**.

## Climate Bar

`services/mystrip_bar/mystrip-bar`, one Node 8 program the Store installs as
a root service (`tools` in `mgu-repo.json`). Only a root client named in the
Renderer's `overlay_apps` may draw and take touch in the climate bar, so at
its start it adds `mystrip_bar` to `overlay_apps` in the Renderer's own
settings file (`/var/opt/mgu-render/mgu-render.local.conf`), keeping every
other line. The Renderer reads that file when it starts, so the bar works
from the next start of the head unit after the first install.

- BMW's seat indicator shows only at very high, and the climate bar is
  see-through, so nothing can hide it. By default (**Seat icons: auto**, in
  line-up) a seat's icon is drawn at every other level and left out at very
  high, where BMW's own shows in its place. Under it a level bar (four
  segments with small gaps, one lit red per level: grey at off, full at very
  high) shows at every level, and the seat is tappable at every level.
  The wheel's icon is always drawn, on its own, at the far right (BMW has no
  wheel indicator), with one solid bar under it (it has one level): red when
  on, grey when off. The bars have square corners.
- Climate Strip's **Seat command** row picks what a seat tap sends: the
  heater stage (`seatHeatingLamination`, proven on the car, but BMW's
  indicator does not follow it) or BMW's level (off to very high), sent
  through the settable Climate field whose seat member runs to `STUFE_4`,
  looked up in the catalogue: the one BMW's indicator is expected to follow.
- It sends nothing to the car. A tap on one of its buttons goes to Climate
  Strip over `/run/mystrip-bar/bar.sock`, which sends the command and tells
  the bar what the car reports.
- **Line up the bar's buttons** (in Climate Strip) outlines the buttons;
  tap one on the bar to pick it, then move it, resize, or change the patch
  that hides BMW's indicator beneath. The positions are kept in
  `/var/opt/mystrip_bar/settings.json`.
- **Safe mode:** restarting the head unit twice, each time within two
  minutes of it starting (or the service crashing three times running),
  turns the bar off. Climate Strip's **Climate bar** row turns it on again.
- The icons are the owner's own drawings (`services/mystrip_bar/icons`,
  PNG, or SVG when there is one): white when off, red when on.
  `node tools/make_bar_icons.js` (Playwright) draws them at the bar's size
  and writes them into the service.
- To remove it: the Store's list, **Climate Bar**, **Remove**. The
  `overlay_apps` line stays and does nothing without it.

## Building and testing on a computer

Node 18 or newer:

```sh
cd apps/mystrip_finder
node tools/gen_rhmi.js      # writes the screens and text files into mystrip_finder@<version>/rhmiData
node tools/test_finder.js   # offline check against a stand-in SDK and a made-up catalogue
cd ../..
node tools/make_watch.js                          # writes apps/mystrip_watchseat and apps/mystrip_watchwheel
node tools/watch/test_watch.js mystrip_watchseat  # offline check of a Heat Watch app
node tools/make_strip.js && node tools/strip/test_strip.js   # Climate Strip
node services/mystrip_bar/test_bar.js             # Climate Bar, against a stand-in Renderer
```

## Credits and licence

The app's structure (the OnlineApp lifecycle, its iDrive 8 screens and
how presses, the entry point and visibility are handled), its
`manifest.json` and `permissions.json` follow the MGU Store by Robert
Nisipeanu ([robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store),
GPL-3.0). This repository is therefore licensed under the GNU General
Public License 3.0 or later (`LICENSE`).
