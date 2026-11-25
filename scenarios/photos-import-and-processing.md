# Photos: import and processing

This file specifies how photos and videos get into Photos and what Photos makes from them: adding a photo in Photos, the previews Photos makes for photos that arrive from a watched folder or another device, the details Photos reads from each file, how grid tiles pick and upgrade their previews, the formats a computer or the cloud cannot read, and video posters and playback. The member uses Photos on a computer, cloud-served Photos in a browser, and the phone's info sheet. The local operator reads admin-web's Storage page to see what a computer keeps. Photos on a computer makes the previews for the photos it holds while Photos runs. Cloud-served Photos makes the smaller previews on demand for the photos on screen.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-library.md](photos-library.md): the library grid, the viewer and its sizes, the info panel, and captions
- [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md): albums, public links, cloud-served Photos, and tiles for files still awaiting upload
- [photos-mobile.md](photos-mobile.md): the phone's library, viewer, and info sheet
- [photos-mobile-sync.md](photos-mobile-sync.md): the phone's import, its own previews, and its uploads
- [photos-people.md](photos-people.md): face recognition and its scan
- starkeep-core [local-data-server.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/local-data-server.md): watched folders
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): records, types, identical files, and capture-time order
- starkeep-core [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md): which sizes each device keeps, and the stand-in standards
- starkeep-core [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md): upload order and files awaiting upload
- starkeep-core [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md): photos and videos reaching the member's other devices

## Adding photos in Photos

Photos on a computer shows an "Add Photo" button in its toolbar. Cloud-served Photos shows the same button as "Upload Photo". Each adds one file that the member picks.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-001] A member adds a photo with "Add Photo" and sees it in the library with its previews
  Given the member has Photos open on a computer with Photos running
  When the member presses "Add Photo" and picks "beach.jpg"
  Then the button reads "Adding…" while the photo is added
  And "beach.jpg" appears in the library
  And the photo's tile shows its thumbnail once Photos has made it, without a reload
```

- **Notes:** Photos reads the photo's dimensions and camera details in the browser and records them right after it registers the photo, so the photo sorts at its date taken from the start. Photos on the computer makes the previews in the background, as for a photo from a watched folder (PHOTOS-IMPORT-006).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-002] A member uploads a photo with "Upload Photo" in cloud Photos and sees it in the library with its previews
  Given the member is signed in to cloud Photos in a browser
  When the member presses "Upload Photo" and picks "beach.jpg"
  Then the button reads "Uploading…" while the photo uploads
  And "beach.jpg" appears in the library
  And the photo's tile shows its thumbnail once cloud Photos has made it, without a reload
```

- **Notes:** cloud Photos makes the previews that the photos on screen need (PHOTOS-IMPORT-031). A computer running Photos does not make previews for this photo unless the computer holds its original.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-003] A member who adds a photo already in the library is told that nothing was added
  Given the member's library already holds "beach.jpg"
  When the member adds the same "beach.jpg" file again with "Add Photo" or "Upload Photo"
  Then Photos says "\"beach.jpg\" is already in your photos — nothing was added."
  And the library still shows one "beach.jpg"
  And the message goes away after five seconds, or when the member presses its "×" button
```

- **Notes:** the same bytes under another file name become a second photo, under the platform's rule for identical files (SHARED-012 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md), LDS-061 in [local-data-server.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/local-data-server.md)).

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-004] A member can add every kind of file Photos shows, videos and camera raw files included
  Given the member's library shows videos and camera raw photos
  When the member presses "Add Photo" or "Upload Photo"
  Then the file chooser offers videos, camera raw files, and BMP files beside JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF, and TIFF photos
  And a video the member picks appears in the library as a video
```

- **Notes:** Implementation gap: the file chooser offers only JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF, and TIFF files, although Photos shows videos, camera raw files, and BMP files that arrive from a watched folder or a phone. A file that the chooser's "All files" option lets through, such as a video, registers as a JPEG photo unless its extension names an image type.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-005] A member whose add fails reads what went wrong in plain words
  Given the member's computer, or the cloud, cannot take new files at the moment
  When the member adds "beach.jpg" with "Add Photo" or "Upload Photo"
  Then Photos says in plain words that "beach.jpg" could not be added and that the member can try again
  And the library shows no "beach.jpg"
```

- **Notes:** Implementation gap: the alert above the library shows the failing request's raw error text, such as "S3 PUT failed: 403 Forbidden" or "Data server POST /data/records → 500: …".

## Photos that arrive from elsewhere

Photos on a computer makes the previews in the background while Photos runs, whether or not the member has Photos open in a browser. Photos starts a pass when Photos starts and whenever anything in the library changes, such as a file landing in a watched folder or a photo arriving from the member's phone. Nothing makes previews on a computer while Photos is stopped there.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-006] A member who copies photos into a watched folder finds their thumbnails ready without having opened Photos
  Given Photos is running on the member's computer
  And no browser tab has Photos open
  When the member copies photos into a watched folder
  And the member later opens Photos
  Then each new photo's tile shows its thumbnail as soon as the grid loads
```

- **Notes:** the photos join the library through the watched folder (LDS-048 in starkeep-core's [local-data-server.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/local-data-server.md)). A photo from the member's phone arrives with the phone's own previews ([photos-mobile-sync.md](photos-mobile-sync.md)), and Photos on the computer makes no previews for a photo whose original is not on the computer.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-007] A member who adds photos while Photos is stopped gets their previews once Photos starts
  Given the member copied photos into a watched folder while Photos was stopped on the member's computer
  And the local operator has since started Photos again from its card in admin-web
  And no browser tab has had Photos open since then
  When the member opens Photos once Photos has run for a while
  Then each new photo's tile shows its thumbnail as soon as the grid loads
```

- **Notes:** Photos starts a pass when it starts, so the previews get made without anyone opening Photos in a browser. A pass that Photos' last stop interrupted resumes where it stopped. Starting Photos from admin-web is the local operator's action (APP-LIFE-054 in starkeep-core's [app-lifecycle.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/app-lifecycle.md)).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-008] A member who adds many photos at once sees small thumbnails for all of them before any larger size
  Given Photos is running on the member's computer
  When the member copies a few thousand photos into a watched folder
  And the member keeps Photos open while Photos makes their previews
  Then every new photo's tile shows a blurred preview and then its thumbnail before any new photo opens sharp in the viewer
  And every new photo then opens sharp in a viewer that fills an ordinary laptop screen, before any new photo opens sharp on a larger high-density screen
```

- **Notes:** the first stage also reads each photo's dimensions and camera details. Photos makes the sizes of two photos at a time and leaves half of the computer's cores free. When videos arrive with the photos, their posters and playable copies come last (PHOTOS-IMPORT-046).

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-IMPORT-046] A member who adds many photos and videos at once sees the videos' poster frames only after every photo's sizes
  Given Photos is running on the member's computer
  When the member copies a few thousand photos and a few videos into a watched folder
  And the member keeps Photos open while Photos makes their previews
  Then each new video's tile shows its play mark and a spinner, with no poster frame, while the photos' tiles fill in
  And each new video's tile shows its poster frame only once every new photo opens sharp in the viewer on every screen
```

- **Notes:** Photos makes a video's poster frames together with its playable copy, in the last stage of a pass.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-IMPORT-009] A member sees a Live Photo added to a watched folder as one photo, not a photo and a separate clip
  Given the member has an iPhone Live Photo exported as "IMG_0042.HEIC" and "IMG_0042.MOV"
  When the member copies both files into a watched folder
  Then Photos shows one tile for "IMG_0042.HEIC"
  And the library shows no separate video tile for "IMG_0042.MOV"
```

- **Notes:** Implementation gap: the two files appear as a photo and a separate short video. Photos holds the pairing rules (a shared content identifier, or matching names in one folder), but only an import loop that nothing calls uses them, so no Live Photo is ever paired.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-010] A member sees a photo whose previews failed on one pass get its thumbnail on a later pass
  Given Photos on the member's computer failed to make a photo's previews because the computer ran short of memory
  When the member later copies another photo into a watched folder
  Then the failed photo's tile shows its thumbnail once Photos' next pass reaches it
```

- **Notes:** any later change to the library starts the next pass, and so does a restart of Photos from admin-web. One failed photo does not stop the pass, and the previews already made stay. A photo in a format the computer cannot read is not tried again (PHOTOS-IMPORT-035).

## Photo details read from the file

Photos reads a photo's dimensions and camera details from the file itself: when Photos adds the photo, when Photos on a computer first makes its previews, or when the member opens the photo's info panel and nobody has read the file yet. Photos reads a video's dimensions, length, and recording date from its container when Photos on a computer makes the video's previews.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-011] A member sees the camera details Photos read from a photo in the info panel
  Given the member's photo "PXL_1.jpg" was taken on a Google Pixel 5 at f/1.7, 1/120 s, ISO 100, with its location recorded
  When the member opens the photo and shows its info panel
  Then the panel shows "Camera" as "Google Pixel 5", "Aperture" as "f/1.7", "Exposure" as "1/120s", and "ISO" as "100"
  And the panel shows the lens and the location the camera recorded
```

- **Notes:** a detail the file does not carry has no row, apart from the five core rows (PHOTOS-IMPORT-023).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-012] A member who opens the info panel of a photo whose details nobody has read sees them fill in
  Given the member's library holds a photo whose camera details no device has read yet
  When the member opens the photo and shows its info panel
  Then the panel first shows the details already known
  And the panel then shows the photo's dimensions and camera details without the member reopening it
  And opening the panel again later shows the same details at once
```

- **Notes:** Photos reads the file in the browser and records what it found, so later opens on any device show the details. A photo whose file carries no camera details is read once and not again. Videos are not read this way; their details come from Photos on a computer.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-013] A member finds a photo in the library at the date it was taken, not the date it was added
  Given the member's photo "PXL_1.jpg" was taken on 4 April 2019
  When the member adds the photo to the library today
  And the member opens Photos once Photos has read the photo's details
  Then the photo sits among the member's photos from April 2019, not among today's photos
```

- **Notes:** the library's order by capture time is SHARED-035 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md). A photo from a watched folder sorts by its date added until Photos on the computer reads its details in the first stage of its next pass (PHOTOS-IMPORT-008).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-014] A member sees the same date taken for a photo whichever computer or cloud read the file
  Given the member's photo was taken at 10:29:21 in a place six hours behind UTC, and the file records that offset
  And the member's computers are set to different time zones
  When the member opens the photo's info panel on each computer and in cloud Photos
  Then every one of them shows a date taken that names the same moment, 10:29:21 at UTC−6, whichever time zone it prints the moment in
  And the photo sits at the same place in the library on each of them
```

- **Notes:** Photos takes the time zone from the file's own offset tags and never from the time zone of the device that reads the file. Which time zone the panel prints the moment in is PHOTOS-IMPORT-016.

```gherkin
@local @cloud
@intent:confirmed @suboptimal
Scenario: [PHOTOS-IMPORT-015] A member sees a photo whose file names no time zone dated as if taken at UTC−4
  Given the member's photo records 10:29:21 on 4 April 2026 as its time taken, with no time zone
  When the member adds the photo to the library on any of the member's devices or in cloud Photos
  Then every device shows a date taken for the photo that names the moment 10:29:21 at UTC−4
  And every device places the photo at that same moment in the library
```

- **Suboptimal:** the fallback time zone should be a library-wide setting that every device reads, so a member who lives elsewhere gets dates in the member's own time zone.
- **Notes:** UTC−4 is US Eastern daylight time. Photos never uses GPS or the reading device's time zone to fill the gap, so every device agrees.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-016] A member reads a photo's date taken in the info panel as the camera's clock showed it
  Given the member's photo was taken at 10:29:21 on 4 April 2026 in a place six hours behind UTC, and the file records that offset
  When the member opens the photo's info panel
  Then the panel shows "Date taken" as "2026-04-04 10:29:21"
```

- **Notes:** Implementation gap: the panel prints the moment in UTC with no zone, "2026-04-04 16:29:21". The phone's info sheet prints the same.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-017] A member sees no date taken for a photo whose file states none
  Given the member's screenshot carries no time taken in its file
  When the member opens the screenshot's info panel in Photos on the web
  Then the panel shows the "Date taken" row with no value
```

- **Notes:** Implementation gap: the web panel shows the date the screenshot was added under "Date taken". A camera whose clock was never set writes a time of all zeroes, which Photos reads as no time taken. The phone's sheet leaves the row out (PHOTOS-IMPORT-024).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-018] A member sees a photo stored sideways upright, in a tile of the upright shape
  Given the member's camera stored a portrait photo as a 4000 × 3000 frame marked to turn 90° clockwise
  When the member opens Photos
  Then the photo's tile shows the photo upright
  And the tile has the photo's upright portrait shape, taller than it is wide
```

- **Notes:** the info panel's "Orientation" row shows "Rotated 90° CW" (PHOTOS-IMPORT-022). A photo marked to turn 180° keeps its stored shape.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-019] A member finds a video in the library at the date the camera recorded it, not the date it was last saved
  Given the member recorded a video on an iPhone in 2019
  And an editing app re-saved the video in 2026
  And Photos is running on the member's computer
  When the member copies the video into a watched folder
  And the member opens Photos once the video shows its poster frame
  Then the video sits among the member's photos and videos from 2019
```

- **Notes:** Photos prefers the QuickTime recording date, which carries a real time zone, over the container's general creation time, which an editing app rewrites.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-020] A member sees a portrait video upright, in a portrait tile
  Given the member recorded a portrait video on a phone, which stores it as a landscape frame marked to turn
  And Photos is running on the member's computer
  When the member copies the video into a watched folder
  And the member opens Photos once Photos has made the video's poster frame
  Then the video's tile is taller than it is wide
  And its poster frame shows the scene upright
```

## How a photo's details read

Photos on the web shows a photo's details in the viewer's info panel, and the phone shows them in its info sheet. Both list the same rows, in the same order and format, and each draws them its own way.

```gherkin
@local @cloud @mobile
@intent:confirmed
Scenario: [PHOTOS-IMPORT-021] A member reads a photo's details in the same order on the web and on the phone
  Given the member's photo carries every detail Photos reads
  When the member opens the photo's details in Photos on the web and on the phone
  Then both list the rows in this order: "Filename", "Dimensions", "Megapixels", "MIME type", "File size", "Date taken", "Camera", "Aperture", "Exposure", "ISO", "Lens", "Orientation", "Location"
```

- **Notes:** Photos offers the member no way to give a photo a title, so neither surface shows a "Title" row.

```gherkin
@local @cloud @mobile
@intent:confirmed
Scenario Outline: [PHOTOS-IMPORT-022] A member reads a photo's dimensions, megapixels, file size, camera, aperture, orientation, and location in Photos' own format
  Given the member's photo has <fact>
  When the member opens the photo's details in Photos on the web or on the phone
  Then the "<row>" row reads "<value>"

  Examples:
    | fact                                        | row         | value                 |
    | a 4000 by 3000 pixel frame                  | Dimensions  | 4000 × 3000px         |
    | a 4000 by 3000 pixel frame                  | Megapixels  | 12.0 MP               |
    | a file of 2,097,152 bytes                   | File size   | 2.0 MB                |
    | a file of 1,536 bytes                       | File size   | 1.5 KB                |
    | the camera make Google and model Pixel 5    | Camera      | Google Pixel 5        |
    | an aperture of f/1.7                        | Aperture    | f/1.7                 |
    | an orientation that turns it 90° clockwise  | Orientation | Rotated 90° CW        |
    | the location 47.1234567, -122.7654321       | Location    | 47.12346, -122.76543  |
```

- **Notes:** the "Exposure" row prints what the device that read the file recorded. Photos on a computer and in the cloud record "1/120s". The date taken's format is PHOTOS-IMPORT-016.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-023] A member sees a blank "Dimensions" row in the web info panel for a photo whose size no device could read
  Given the member uploaded "IMG_0042.HEIC" through "Upload Photo" in cloud Photos, in a browser that cannot show HEIC files
  And no device has made previews for the photo
  When the member opens the photo's info panel in cloud Photos
  Then the panel shows the "Dimensions" row with no value
  And the panel shows no "Megapixels" row
```

- **Notes:** the web panel always keeps its five core rows, "Filename", "Dimensions", "MIME type", "File size", and "Date taken", with a blank value when one is unknown, and leaves out every other unknown row. Implementation gap: the "Dimensions" row reads "0 × 0px".

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-IMPORT-024] A member sees the phone's info sheet leave out every detail nobody has read
  Given the member's library holds a photo whose file name, MIME type, and file size are known, and whose other details no device has read yet
  When the member opens the photo's info sheet on the phone
  Then the sheet shows only "Filename", "MIME type", and "File size"
```

## Previews in the grid

Photos keeps a ladder of preview sizes for each photo, smallest first, and makes only the sizes below the photo's own size. Each grid tile asks for the smallest size that covers the tile on screen, counted in the screen's real pixels. The sizes themselves are provisional and may change.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-025] A member sees a blurred preview of a new photo before its thumbnail loads
  Given the member's library holds a photo whose thumbnail has not loaded on this screen yet
  And Photos has read the photo once, so it knows its colours and shape
  When the member scrolls the photo into view
  Then the tile shows a blurred version of the photo at once
  And the thumbnail replaces the blurred version when it loads
```

- **Notes:** the blurred version rides with the photo's other details, so it costs no extra download. Photos records it in the first stage of a pass, before any preview size (PHOTOS-IMPORT-008).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-026] A member sees each tile sharp at its size on screen, on a high-density screen too
  Given the member views the grid on a screen with three device pixels to each CSS pixel
  And a landscape photo's tile is 180 by 120 CSS pixels
  When the tile loads
  Then the tile shows the photo's 640-pixel preview, not the 320-pixel one
  And a taller row of tiles shows a larger preview of the same photo
```

- **Notes:** the tile needs 540 pixels on its long edge, and Photos rounds up to the next size it makes. The tile asks for its preview only once it comes near the screen. A photo turned by its orientation is measured in its upright shape.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-027] A member sees a tile show a smaller size while the right size is made, and then sharpen in place
  Given the member's photo has its smallest preview sizes, but not the size its tile needs
  When the member scrolls the photo into view
  Then the tile shows the largest smaller size at once
  And the tile switches to the right size once it exists, without going blank or blurred in between
```

- **Notes:** a tile never fetches a size larger than the one it needs as a stand-in. In cloud Photos the tile asks the cloud to make the missing size (PHOTOS-IMPORT-031). On a computer, Photos' background pass makes it.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-028] A member sees a small photo's own image in its tile before any preview exists
  Given the member's photo file is 512 KB or smaller
  And Photos has made no preview for it yet
  When the member scrolls the photo into view
  Then the tile shows the photo itself
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-029] A member sees a spinner, not a large photo's full original, in its tile while its previews are made
  Given the member's photo file is larger than 512 KB
  And Photos has made no preview size for it yet
  When the member scrolls the photo into view
  Then the tile shows a spinner, not the photo itself
  And the tile shows the thumbnail once Photos has made it, without a reload
```

- **Notes:** when Photos has already read the photo's colours and shape, the blurred version shows under the spinner (PHOTOS-IMPORT-025).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-030] A member sees a tile whose image failed to load keep its preview and spinner, and load on a later try
  Given a tile's image fails to load because of a brief network error
  When the member keeps the grid open
  Then the tile keeps its blurred version and spinner and shows no broken-image icon
  And the tile shows its image after a later try, within 90 seconds of the network working again
```

- **Notes:** Photos tries again after 5 seconds, doubling the wait up to one minute, and resets the wait whenever any tile on screen fills in.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-031] A member who opens cloud Photos sees previews for photos that no computer has processed
  Given the member uploaded JPEG photos larger than 512 KB through cloud Photos, and no computer running Photos holds their originals
  When the member opens cloud Photos and scrolls to the photos
  Then each tile on screen shows a spinner first, and then its thumbnail without a reload
  And a photo the member opens in the viewer shows a sharp image once cloud Photos has made the viewer's size
```

- **Notes:** cloud Photos makes only the sizes the screen asks for, plus the two smallest sizes, a few photos at a time. The cloud reads JPEG, PNG, WebP, and AVIF photos (PHOTOS-IMPORT-036 covers the rest). A photo that a computer without Photos added through Drive takes the same path.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-032] A member sees a tile whose preview the busy cloud could not make fill in later without a reload
  Given the member opens cloud Photos on photos that have no previews yet
  And the deployment is too busy to make one tile's preview at the first request
  When the member keeps cloud Photos open
  Then that tile shows its thumbnail once the deployment has room, without a reload
```

- **Notes:** Implementation gap: Photos asks for each missing size once per page load and does not ask again after a failed request, so the tile keeps its spinner until the member reloads the page.

## Photos the computer or the cloud cannot read

Photos on a computer reads HEIC and HEIF photos only on a Mac, through the Mac's own decoder. Photos reads a camera raw file through the full-size JPEG preview that the camera stores inside it. Cloud Photos reads only JPEG, PNG, WebP, and AVIF photos. A photo whose previews a computer or a phone already made shows those previews everywhere, whatever the format.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-033] A member on a Mac sees HEIC photos from a watched folder with their previews
  Given Photos is running on the member's Mac
  When the member copies iPhone photos saved as HEIC files into a watched folder
  And the member opens Photos in a browser that cannot show HEIC files itself, once Photos' pass has reached the photos
  Then each HEIC photo's tile shows its thumbnail
  And the viewer shows each photo sharp at its larger sizes
```

- **Notes:** the previews reach the cloud with the computer's other files, so cloud Photos shows the same photos with their previews.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-034] A member sees a camera raw photo as the camera's own full-size preview
  Given Photos is running on the member's computer
  And the member's camera stores a full-size JPEG preview inside each raw file
  When the member copies the camera's DNG files into a watched folder
  And the member opens Photos
  Then each raw photo's tile and the viewer show the picture the camera showed on its own screen
  And the viewer's largest size is no larger than the camera's preview
```

- **Notes:** Photos takes the largest preview inside the file and skips the small thumbnail the camera also stores. Camera raw files are typed as images (SHARED-005 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)).

```gherkin
@local
@intent:unclear
Scenario Outline: [PHOTOS-IMPORT-035] A member sees "Cannot be displayed" and an accurate explanation on a photo the computer cannot read, for a HEIC photo off a Mac and a raw file with no preview
  Given Photos is running on the member's computer
  And the member copied <photo> into a watched folder
  When the member opens Photos once Photos' pass has reached the photo
  Then the photo's tile shows "Cannot be displayed" and a round "i" button
  And pressing the button explains that <reason>, and that the photo itself is safe and unchanged
  And the explanation promises no fix that this computer will not make

  Examples:
    | photo                                         | reason                                         |
    | a HEIC photo, on a computer that is not a Mac | this computer cannot read HEIC photos          |
    | a raw file that holds no JPEG preview          | the file holds no picture that Photos can show |
```

- **Notes:** Implementation gap: the explanation reads "This photo is stored in a format this server cannot read, so the smaller sizes the grid needs have not been made yet." and then "The photo itself is safe and unmodified. Opening Photos on the machine that holds it, or on the mobile app, will produce the missing sizes and fix this automatically." The computer that shows the tile already holds the photo, and nothing makes sizes for a raw file without a preview. Photos does not try the photo again until someone deletes the computer's record of the failed attempt.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-036] A member sees "Cannot be displayed" and an accurate explanation in cloud Photos on a photo nothing can make previews for
  Given the member uploaded "IMG_0042.HEIC" through "Upload Photo" in cloud Photos
  And no device has made previews for the photo
  When the member scrolls the photo into view in cloud Photos
  Then the photo's tile shows "Cannot be displayed" and a round "i" button
  And pressing the button explains that cloud Photos cannot read HEIC photos, and that the photo itself is safe and unchanged
  And the explanation promises no fix that no device will make
```

- **Notes:** Implementation gap: the explanation tells the member that opening Photos on the machine that holds the photo, or on the mobile app, will fix it. No machine holds a photo uploaded through cloud Photos, and Photos on a computer makes still previews only from an original already on that computer. A HEIC photo from the member's phone arrives with the phone's own previews ([photos-mobile-sync.md](photos-mobile-sync.md)), so cloud Photos shows it.

## Videos

Photos on a computer makes each video's poster frames and its playable copy, a smaller WebM file that every current browser plays. No other device makes them: a phone has no video encoder, and the cloud makes no video previews. Photos on a computer therefore fetches a video's original from the cloud when the computer lacks it, which no still photo gets.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-037] A member sees a video in the grid as a poster frame with a play mark
  Given the member's library holds a video that Photos on a computer has processed
  When the member opens Photos
  Then the video's tile shows a frame from the video with a white play mark over it
  And a still photo's tile shows no play mark
```

- **Notes:** the play mark shows on a video's tile before the poster arrives too, and the poster replaces the empty tile without a reload. Poster frames stay on every device offline (RESIDENCY-002 and RESIDENCY-006 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md)).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-IMPORT-038] A member plays a video on the computer that holds it before its playable copy exists
  Given the member copied an MP4 video recorded in H.264 into a watched folder a moment ago
  And Photos has not made the video's playable copy yet
  When the member opens the video in Photos on that computer
  Then the video plays from the original, with the player's controls
```

- **Notes:** once the playable copy exists, the viewer plays the copy instead. Seeking works because every file answer supports ranges (SHARED-101 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-039] A member plays a video in cloud Photos from its playable copy
  Given Photos on the member's computer made a video's playable copy, and the copy reached the cloud
  When the member opens the video in cloud Photos
  Then the video plays with the player's controls
  And the member can skip to any point in the video
```

- **Notes:** cloud Photos plays only the playable copy and never streams the original, which may be far larger. A visitor's public link to a video plays the same copy (SHARED-153 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-040] A member sees "Video data is syncing…" over the poster while cloud Photos has no playable copy yet
  Given the member's video shows its poster frame in cloud Photos
  And its playable copy, which a computer running Photos made, has not reached the cloud yet
  When the member opens the video in cloud Photos
  Then the viewer shows the poster frame with "Video data is syncing…" along the bottom of the viewer
  And the viewer offers no play button
```

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-IMPORT-041] A member whose browser cannot play a video's original learns that the video is waiting for its playable copy
  Given the member copied an iPhone video recorded in HEVC into a watched folder on a computer
  And the member's browser cannot play HEVC video
  And Photos has not made the video's playable copy yet
  When the member opens the video in Photos on that computer
  Then the viewer says that the video will play once Photos has made a copy this browser can play
  And the viewer plays the copy once it exists, without the member reopening the video
```

- **Notes:** Implementation gap: the viewer shows "Video data is syncing…", although the video's file sits on this computer and nothing is syncing.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-IMPORT-042] A member plays a phone video in cloud Photos once a computer running Photos has made its playable copy
  Given Photos is running on the member's computer
  And the member's phone finished uploading a video that the member recorded on it
  When the member opens the video in cloud Photos after Photos on the computer has had time to make its playable copy
  Then the video plays with the player's controls
```

- **Notes:** Photos on the computer fetches the video's original from the cloud, makes the poster frames and the playable copy, and sends them back to the cloud. A phone video shows on the computer while its upload runs (SYNC-013 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md)). How long a video's upload takes from the phone is BYTES-014 in starkeep-core's [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md).

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-IMPORT-043] A member with no computer running Photos learns why phone videos do not play in cloud Photos
  Given the member uses Photos on a phone and in the cloud, and no computer of the member's runs Photos
  And the member's phone finished uploading a video
  When the member opens the video in cloud Photos
  Then the viewer says that the video becomes playable here once Photos runs on one of the member's computers
```

- **Notes:** Implementation gap: the viewer shows "Video data is syncing…" with no end, because no device makes the playable copy.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-IMPORT-044] A member whose computer lacks the video tools learns why videos get no previews there
  Given Photos is running on a computer that has no ffmpeg installed
  When the member copies videos into a watched folder
  And the member opens Photos
  Then Photos says that this computer needs ffmpeg to make video posters and playable copies
  And the video tiles show their play mark without an endless spinner
```

- **Notes:** Implementation gap: each video tile keeps its play mark and a spinner with no poster, and nothing tells the member why. Photos does not try those videos again until someone deletes the computer's record of the failed attempts.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-IMPORT-045] A local operator finds that a phone video's original does not stay on the computer after Photos made its playable copy
  Given Photos is running on the local operator's computer
  And nobody changed the computer's ceilings, and "Keep originals here" is off
  And a member's phone uploaded a video, and Photos on the computer made the video's playable copy
  When the local operator opens the Storage page
  Then the Videos row of the ceilings table does not count the video's original under "Originals here"
```

- **Notes:** Implementation gap: the original that Photos fetched to make the playable copy stays on the computer until the local operator runs "Free up space" (RESIDENCY-030 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md)), although the computer's video ceiling keeps no original.
