# climate-strip

Personal apps for a BMW iDrive 8 head unit, installed through the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

| App | Id | What it does |
|---|---|---|
| Signal Finder | `mystrip_finder` | Read-only. Searches the head unit's system folders for its SOME/IP interface catalogue and lists every seat-heating and steering-wheel-heating entry, plus the climate, seat and steering-wheel interfaces by name. Tap an entry to see it in full; **Save report to USB** writes everything to `signal-finder-report.txt` on a USB stick. Sends nothing to the car. |

iDrive 8 only. The head unit builds each app from this repository's source
(a source package, `"build": "unit"`), linking it against the BMW app SDK
already on the car, so no SDK is in this repository.

## Installing

1. In the Store, open **Sources**, **Add source**, and type this
   repository as `<your GitHub name>/climate-strip`. Pick its branch
   (`main`) if the Store asks for a channel.
2. Install **Signal Finder**, then restart the head unit once when the
   Store asks (on iDrive 8 an app installs at the next start).
3. Open **Signal Finder** from *All apps*. It scans by itself when it
   opens (usually well under a minute).
4. Plug a FAT32-formatted USB stick into the car and press **Save report
   to USB**. The status line says where it saved, or why it couldn't.
   If saving doesn't work, photograph the list and a few entries instead.

To remove it: the Store's app list, **Signal Finder**, **Remove**.

## Building and testing on a computer

Node 18 or newer:

```sh
cd apps/mystrip_finder
node tools/gen_rhmi.js      # writes the screens and text files into mystrip_finder@<version>/rhmiData
node tools/test_finder.js   # offline check against a stand-in SDK and a made-up catalogue
```

## Credits and licence

The app's structure (the OnlineApp lifecycle, its iDrive 8 screens and
how presses, the entry point and visibility are handled), its
`manifest.json` and `permissions.json` follow the MGU Store by Robert
Nisipeanu ([robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store),
GPL-3.0). This repository is therefore licensed under the GNU General
Public License 3.0 or later (`LICENSE`).
