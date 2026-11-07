# climate-strip

Personal apps for a BMW iDrive 8 head unit, installed through the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Id | What it does |
|---|---|---|
| Signal Finder | `mystrip_finder` | Read-only. Reads the head unit's SOME/IP interface catalogue (`/etc/oap/someip/someip-interfaces.json`) and lists the interfaces with seat-heating or steering-wheel-heating parts. Tap an interface for its parts, each marked GET / SET / NOTIFY (fields), CALL (methods) or EVENT; tap a part for its data type spelled out and its raw catalogue entry. Sends nothing to the car. |
| Heat Watch Seats | `mystrip_watchseat` | Read-only. A live log of every value that changes on `de.bmw.infotainment.climate.Climate` while the car's own seat heating buttons are pressed (newest first; start values marked "start"). **Clear log** empties it. |
| Heat Watch Wheel | `mystrip_watchwheel` | The same for `de.bmw.body.steeringwheelcomfort.SteeringWheelClimate` and the steering wheel heating button. |
| Heat Watch Master | `mystrip_watchmaster` | The same for `de.bmw.infotainment.climate.climatemaster.ClimateMaster` (seat and steering wheel heating). |

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

## Building and testing on a computer

Node 18 or newer:

```sh
cd apps/mystrip_finder
node tools/gen_rhmi.js      # writes the screens and text files into mystrip_finder@<version>/rhmiData
node tools/test_finder.js   # offline check against a stand-in SDK and a made-up catalogue
cd ../..
node tools/make_watch.js                          # writes apps/mystrip_watchseat and apps/mystrip_watchwheel
node tools/watch/test_watch.js mystrip_watchseat  # offline check of a Heat Watch app
```

## Credits and licence

The app's structure (the OnlineApp lifecycle, its iDrive 8 screens and
how presses, the entry point and visibility are handled), its
`manifest.json` and `permissions.json` follow the MGU Store by Robert
Nisipeanu ([robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store),
GPL-3.0). This repository is therefore licensed under the GNU General
Public License 3.0 or later (`LICENSE`).
