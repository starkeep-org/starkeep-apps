# Photos on the phone: imports, background backup, and the phone's own previews

This file specifies what Photos on an Android phone brings in from the phone's camera roll, how the phone backs photos up while Photos is closed and while it is open, which network, battery, and storage conditions hold that work back, and the previews the phone makes and keeps for its own photos. Every scenario has the member as its actor. Photos on the phone needs no sign-in for the photos the phone holds, and signing in buys sync with the member's deployment.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-mobile.md](photos-mobile.md): the first-run screen, the photo access prompt, the grid and the viewer, sign-in, and the Settings screen's Sync and Storage sections, including when the open app uploads and "Sync now"
- [photos-import-and-processing.md](photos-import-and-processing.md): the details read from each file on the computer, and the info rows the phone shares with the web
- [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md): how photos from the phone look in cloud Photos
- starkeep-core [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md): photos reaching the member's other devices
- starkeep-core [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md): upload order, large videos, retries, and files awaiting upload
- starkeep-core [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md): which sizes a phone keeps under its ceilings, and freeing up space
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): deletion, the trash window, and restore

## What an import brings in

### Photos and videos from the camera roll

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-001] A member sees a photo that a messaging app saved on the phone appear in Photos
  Given Photos on the member's phone has imported the camera roll before
  And a messaging app saved a photo that a friend sent to the member
  When the member opens Photos
  Then the grid shows the friend's photo beside the photos the phone's camera took
```

- **Notes:** Photos brings in every photo and video that Android lists in the phone's media library, whichever app saved it.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-002] A member finds no audio recordings from the phone in Photos
  Given Photos on the member's phone has imported the camera roll before
  And the member recorded a voice clip with the phone's recorder app
  When the member opens Photos
  Then the grid does not show the voice clip
```

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-003] A member whose phone holds years of photos is offered the photos older than two weeks
  Given the member's phone holds photos from the last five years
  And the member chose "Import without signing in" when Photos first ran on the phone, and allowed Photos to read the phone's photos
  When the member opens Photos after the first import finishes
  Then the grid shows the photos that appeared on the phone in the last two weeks
  And Photos offers the member a way to add the older photos
```

- **Notes:** Implementation gap: Photos brings in only the photos and videos that appeared or changed on the phone in the last 14 days, and offers no way to add older ones. A photo saved or received recently counts as recent even when it was taken long ago. Older photos that another device already put in the member's library arrive by sync.

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-004] A member whose phone took 300 photos in the last two weeks sees all of them without reopening Photos
  Given the member's phone took 300 photos in the last two weeks
  And the member chose "Import without signing in" when Photos first ran on the phone
  When the member chooses "Import" in the dialog that follows, allows Photos to read the phone's photos when Android asks, and keeps Photos open for five minutes
  Then the grid shows all 300 photos
```

- **Notes:** Implementation gap: one opening of Photos imports at most 60 photos, the oldest first. The rest wait for the member to pull down on the grid (PHOTOS-MOB-021), to return to Photos more than a minute later, or for a background window, which imports 20 at a time.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-005] A member sees a 400 MB video recorded on the phone in Photos, with its poster frame
  Given Photos on the member's phone has imported the camera roll before
  And the member recorded a 400 MB video with the phone's camera app
  When the member opens Photos
  Then the grid shows the video's tile with a frame from the video
```

- **Notes:** the upload of a large video is BYTES-014 and BYTES-016 in starkeep-core's [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md). The tile's play mark and length are PHOTOS-MOB-013 in [photos-mobile.md](photos-mobile.md).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-006] A member sees a photo larger than 64 MB from the phone in Photos
  Given Photos on the member's phone has imported the camera roll before
  And the member's camera app saved a 70 MB panorama photo
  When the member opens Photos
  Then the grid shows the panorama
```

- **Notes:** Implementation gap: the phone skips any photo larger than 64 MB, says nothing about it, and never tries the photo again. Videos of any size import (PHOTOS-MOBSYNC-005).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-007] A member finds a video recorded on the phone at the moment it was recorded
  Given Photos on the member's phone has imported the camera roll before
  And the member copied onto the phone today a video the member recorded in 2019
  When the member opens Photos and scrolls to the member's photos from 2019
  Then the video sits among the photos and videos from 2019
```

- **Notes:** the phone reads the recording moment from the video itself, as the computer does (PHOTOS-IMPORT-019 in [photos-import-and-processing.md](photos-import-and-processing.md)).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-008] A member sees a portrait video from the phone in a portrait tile in cloud Photos
  Given the member's phone is signed in
  And the member recorded a video with the phone held upright, and the phone has sent it to the cloud
  When the member opens cloud Photos and scrolls to the video
  Then the video's tile is taller than it is wide
```

- **Notes:** the phone records the video's displayed size rather than the size of its stored frame. The computer's path is PHOTOS-IMPORT-020 in [photos-import-and-processing.md](photos-import-and-processing.md).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-009] A member finds a HEIC photo taken on the phone among the photos taken the same day
  Given Photos on the member's phone has imported the camera roll before
  And the member's camera app saves photos as HEIC files
  And the member took a photo a moment ago
  When the member opens Photos
  Then the new photo sits at the top of the grid with the other photos taken today
```

- **Notes:** Implementation gap: the phone reads the moment a photo was taken only from a JPEG file. A HEIC photo gets no capture time on the phone, so the grid puts it after every dated photo, at the end of the library.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-010] A member who copies a photo from the computer to the phone sees it once in Photos
  Given the member's phone is signed in, and the phone's grid shows a beach photo that the member added on the computer as "beach.jpg"
  When the member copies the same "beach.jpg" from the computer onto the phone, and opens Photos
  Then the grid shows the beach photo once
```

- **Notes:** the same file under the same name is one photo everywhere. A copy saved under another name is a second photo that shares the stored file (SYNC-005 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md)).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-040] A member reads where a video recorded on the phone was taken
  Given the member allowed Photos to read the phone's photos
  And the member recorded a video in a park with the phone's camera app, with the camera saving locations
  When the member opens the video in Photos and opens its info sheet
  Then the info sheet shows a "Location" row with the park's coordinates
```

- **Notes:** the rows the info sheet shows are PHOTOS-IMPORT-021 in [photos-import-and-processing.md](photos-import-and-processing.md).

### Photos edited or removed in another app

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-011] A member who edits a photo in another app sees the edited version in Photos
  Given Photos on the member's phone imported a photo the member took
  When the member crops the photo in an editing app that saves over the original, and opens Photos
  Then the grid shows the cropped photo
```

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-012] A member who edits a photo in another app keeps the version from before the edit in Photos
  Given the member's phone is signed in, and a photo the member took has reached the cloud
  When the member crops the photo in an editing app that saves over the original, and opens Photos
  Then the grid also shows the photo as it was before the crop
```

- **Notes:** the earlier version opens from the cloud, because the phone no longer holds its file.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-013] A member who removes an uploaded photo from the camera roll still sees it in Photos
  Given the member's phone is signed in, and a photo the member took has reached the cloud
  When the member deletes the photo in the phone's gallery app, and opens Photos
  Then the grid still shows the photo
  And the photo opens in the viewer
```

- **Notes:** a photo removed from the camera roll before its original uploaded is BYTES-011 in starkeep-core's [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md). The computer keeps a removed watched file the same way (LDS-053 in starkeep-core's [local-data-server.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/local-data-server.md)). Deleting the photo in Photos removes it from the library (PHOTOS-MOB-047 in [photos-mobile.md](photos-mobile.md)).

### Deleted photos

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-014] A member who deletes a phone photo in cloud Photos does not see it return on the phone
  Given the member's phone is signed in, and a photo the member took has reached the cloud
  And the member deleted the photo in cloud Photos, and the photo has left the phone's grid
  And the photo's file is still in the phone's camera roll
  When the member opens Photos on the phone the next day
  Then the grid does not show the photo
```

- **Notes:** a deletion made on the phone is PHOTOS-MOB-047 to PHOTOS-MOB-050 in [photos-mobile.md](photos-mobile.md). A deletion reaching the member's devices is SHARED-110 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md).

### After a reinstall

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-015] A member who reinstalls Photos and signs in first sees each photo once
  Given the member's phone took 50 photos last week, and they all reached the member's cloud library
  And the member reinstalled Photos on the phone, signed in from the first-run screen, and waited for the library to arrive
  When the member allows Photos to read the phone's photos when Android asks, and scrolls through last week in the grid
  Then the grid shows each of the 50 photos once
  And cloud Photos shows each of the 50 photos once
```

- **Notes:** clearing Photos' storage in Android's settings starts the phone from the same fresh library. The first-run screen and the wait for the library are PHOTOS-MOB-003 and PHOTOS-MOB-086 in [photos-mobile.md](photos-mobile.md).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-016] A member who reinstalls Photos and signs in first does not see deleted photos come back
  Given the member deleted 3 photos that the phone took last week in Photos on the signed-in phone, and their files stayed in the camera roll
  And the member reinstalled Photos on the phone, signed in from the first-run screen, and waited for the library to arrive
  When the member allows Photos to read the phone's photos when Android asks, and scrolls through last week in the grid
  Then the grid does not show the 3 photos
  And cloud Photos does not show the 3 photos
```

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-017] A member who reinstalls Photos and imports before the library arrives does not see deleted photos come back
  Given the member deleted 3 photos that the phone took last week in Photos on the signed-in phone, and their files stayed in the camera roll
  And the member reinstalled Photos on the phone, signed in, chose "Import without waiting" before the library arrived, and allowed Photos to read the phone's photos
  When the member waits until the library has arrived, and scrolls through last week in the grid
  Then the grid does not show the 3 photos
  And cloud Photos does not show the 3 photos
```

- **Notes:** Implementation gap: the early import adds the 3 photos again, and they come back on every device. The dialog before the early import warns of this (PHOTOS-MOB-007 in [photos-mobile.md](photos-mobile.md)). A phone that imported without signing in and signs in later meets the same case.

## While Photos is closed

### Background backup

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-018] A member sees a photo taken with Photos closed on the computer within five minutes
  Given the member's phone is signed in and on Wi-Fi, with Battery Saver off
  And the member used Photos on the phone earlier today
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with the phone's camera app and leaves Photos closed
  Then Photos on the computer shows the photo within five minutes
```

- **Notes:** Android starts Photos' background work up to a minute after the camera saves a photo. When Android allows the work depends on how recently the member used Photos (PHOTOS-MOBSYNC-020). A photo taken on a phone reaching the computer is SYNC-002 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-019] A member who takes 100 photos with Photos closed finds all of them on the computer the next morning
  Given the member's phone is signed in, and the member used Photos on the phone earlier today
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes 100 photos in an evening with Photos closed, and leaves the phone charging on Wi-Fi overnight
  Then Photos on the computer shows all 100 photos the next morning
```

- **Notes:** each background window brings in up to 20 photos, the oldest first, so a large batch takes several windows.

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-020] A member who has not opened Photos for days still sees a new photo on the computer within an hour
  Given the member's phone is signed in and on Wi-Fi, with Battery Saver off
  And the member has not opened Photos on the phone for a week
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with the phone's camera app and leaves Photos closed
  Then Photos on the computer shows the photo within an hour
```

- **Notes:** Implementation gap: Android gives an app nobody opens a few short background windows a day, observed hours apart, so the photo can wait until the member next opens Photos or charges the phone.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-021] A member whose Wi-Fi stopped answering during a backup sees later photos reach the computer once it works again
  Given the member's phone is signed in, and the member used Photos on the phone earlier today
  And the phone's Wi-Fi stopped answering, while still connected, during a background backup
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes another photo with Photos closed after the Wi-Fi works again
  Then Photos on the computer shows the new photo within five minutes
```

- **Notes:** a background window gives up on a stalled connection when the window ends, and the next window starts afresh.

### Battery Saver and power

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-022] A member whose phone is in Battery Saver finds photos taken with Photos closed stay off the computer while Battery Saver is on
  Given the member's phone is signed in and on Wi-Fi, with Battery Saver on
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with the phone's camera app, leaves Photos closed, and keeps Battery Saver on all afternoon
  Then Photos on the computer does not show the photo that afternoon
```

- **Notes:** Battery Saver stops Android from giving Photos network access in the background. Opening Photos on Wi-Fi sends the photo (PHOTOS-MOBSYNC-032).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-023] A member whose phone is in Battery Saver learns that the phone's backup is paused
  Given the member's phone is signed in, with Battery Saver on
  When the member opens Settings in Photos
  Then Photos says that photos taken while Photos is closed wait until Battery Saver is off
```

- **Notes:** Implementation gap: nothing in Photos mentions Battery Saver. The Sync section's status line is PHOTOS-MOB-071 to PHOTOS-MOB-075 in [photos-mobile.md](photos-mobile.md).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-024] A member whose phone stays below half battery sees its new photos on the computer offline at 1280 pixels at most
  Given the member's phone is signed in and on Wi-Fi, unplugged all day with the battery below half and Battery Saver off
  And Photos runs on the member's computer, signed in to the same deployment with the default ceilings, and the computer stays online all day
  And the member took a 4000-pixel photo with the phone, and has not opened it on the phone or in cloud Photos
  When the member opens the photo in Photos on the computer that evening with the computer offline
  Then the computer shows the photo at 1280 pixels at most
```

- **Notes:** the phone makes the sizes up to 1280 pixels on any battery, and the 2560-pixel and canonical sizes only while charging or above half battery. Opening the photo on the phone makes the screen's size at once (PHOTOS-MOBSYNC-037). Cloud Photos makes a size itself once the original has reached the cloud (PHOTOS-SHARE-064 in [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md)).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-025] A member whose phone charged overnight sees its new photos on the computer offline at 2560 pixels
  Given the member's phone is signed in, and the member took a 4000-pixel photo with the phone while the battery was below half
  And Photos runs on the member's computer, signed in to the same deployment with the default ceilings
  And the phone charged overnight on Wi-Fi, and the computer stayed online overnight
  When the member opens the photo in Photos on the computer the next morning with the computer offline
  Then the computer shows the photo at 2560 pixels
```

### Mobile data

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-026] A member whose phone is on mobile data finds a photo taken with Photos closed stays off the computer while on mobile data
  Given the member's phone is signed in and on mobile data, and the member used Photos on the phone earlier today
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with Photos closed, and keeps the phone on mobile data all afternoon
  Then Photos on the computer does not show the photo that afternoon
```

- **Notes:** the photo goes up at the phone's first background window on Wi-Fi, or when the member taps "Sync now" (PHOTOS-MOB-073 in [photos-mobile.md](photos-mobile.md)). Captions sync over mobile data (PHOTOS-MOB-045).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-027] A member whose phone uses another phone's hotspot finds new photos stay off the computer while on the hotspot
  Given the member's phone is signed in and joined the hotspot of another phone, and the member used Photos on the phone earlier today
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with Photos closed, and keeps the phone on the hotspot all afternoon
  Then Photos on the computer does not show the photo that afternoon
```

- **Notes:** Implementation gap: Photos treats every Wi-Fi network as free to use, so it uploads over a hotspot or a Wi-Fi network the member marked as metered in Android's settings. The same reading decides when the open app uploads (PHOTOS-MOB-071 in [photos-mobile.md](photos-mobile.md)).

```gherkin
@mobile @cloud
@intent:confirmed @suboptimal
Scenario: [PHOTOS-MOBSYNC-028] A member with Photos open on mobile data does not see a photo added on the computer
  Given the member's phone is signed in and on mobile data
  And a photo the member added on the computer shows in cloud Photos
  When the member keeps Photos open on the phone for five minutes without tapping "Sync now"
  Then the phone's grid does not show the photo
```

- **Suboptimal:** Revisit letting the library's photo listings sync over mobile data while their files still wait for Wi-Fi.
- **Notes:** "Sync now" brings the photo at once (PHOTOS-MOB-073 in [photos-mobile.md](photos-mobile.md)).

### A nearly full phone

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-029] A member whose phone is nearly full still sees new photos reach the computer
  Given the member's phone is signed in and on Wi-Fi, with less than a tenth of its storage free
  And the member used Photos on the phone earlier today
  And Photos runs on the member's computer, signed in to the same deployment
  When the member takes a photo with Photos closed
  Then Photos on the computer shows the photo within five minutes
```

- **Notes:** sending a photo takes no space on the phone, so a full phone still backs up. The phone also makes no previews while less than a tenth of it is free, so what the computer shows before the member frees space is in doubt.

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-030] A member whose phone is nearly full finds that Photos takes no more space while open
  Given the member's phone is signed in and on Wi-Fi, with less than a tenth of its storage free
  And the member added 2,000 photos on the computer, and they show in cloud Photos
  When the member opens Photos on the phone and keeps it open for an hour
  Then Photos' storage details in Android's app settings show that Photos grew by a few megabytes at most
```

- **Notes:** Implementation gap: background windows download nothing while less than a tenth of the phone is free, but a sync while Photos is open downloads previews whatever the space left.

## While Photos is open

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-031] A member who opens Photos sees a photo taken while Photos was closed at the top of the grid
  Given Photos on the member's phone has imported the camera roll before, and the member last used Photos an hour ago
  And the member took a photo with the phone's camera app while Photos was closed
  When the member opens Photos
  Then the new photo appears at the top of the grid within a few seconds
```

- **Notes:** opening Photos brings in new photos with or without a network connection, and whether or not the phone ever signed in.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-032] A member who opens Photos on Wi-Fi sees a photo taken while Photos was closed on the computer within a minute
  Given the member's phone is signed in and on Wi-Fi, and the member last used Photos an hour ago
  And the member took a photo with the phone's camera app while Photos was closed, and the computer does not show it yet
  And Photos runs on the member's computer, signed in to the same deployment
  When the member opens Photos on the phone
  Then Photos on the computer shows the photo within a minute
```

- **Notes:** on mobile data, opening Photos sends the photo only when the member taps "Sync now" (PHOTOS-MOB-072 and PHOTOS-MOB-073 in [photos-mobile.md](photos-mobile.md)).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOBSYNC-033] A member who returns to Photos within a minute sees a photo just taken without pulling down
  Given the member opened Photos on the phone a moment ago
  When the member switches to the phone's camera app, takes a photo, and returns to Photos within 30 seconds
  Then the new photo appears at the top of the grid within a few seconds
```

- **Notes:** Implementation gap: a return to Photos within a minute of its last catch-up brings in nothing, so the photo waits for a background window, a pull on the grid (PHOTOS-MOB-021 in [photos-mobile.md](photos-mobile.md)), or the next return.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-034] A member with Photos open on Wi-Fi sees a photo added on the computer within a minute
  Given the member's phone is signed in and on Wi-Fi, with Photos open
  And a photo the member added on the computer has just appeared in cloud Photos
  When the member keeps Photos open on the phone without touching it
  Then the phone's grid shows the photo within a minute
```

- **Notes:** an open Photos syncs every 30 seconds on Wi-Fi. On mobile data it waits (PHOTOS-MOBSYNC-028).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-035] A member with Photos open sees a photo that another app saves appear in the grid within ten seconds
  Given the member has Photos open on the phone
  And the member's messaging app saves the photos the member receives to the phone
  When the member keeps Photos open while a photo from a friend arrives in the messaging app
  Then the grid shows the friend's photo within ten seconds
```

## The phone's own previews and storage

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-036] A member sees the phone's own photos as sharp tiles with no network and no other device
  Given the member chose "Import without signing in" when Photos first ran on the phone, and Photos imported the camera roll
  And the phone has no network connection
  When the member scrolls through the grid
  Then each tile shows a sharp picture of its photo within a few seconds of scrolling into view
```

- **Notes:** the phone makes the sizes its grid needs from its own photos, on any battery. The blurred version a tile shows first is PHOTOS-MOB-016 in [photos-mobile.md](photos-mobile.md).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-037] A member opens a photo the phone took and sees it sharp at the screen's size with no network
  Given Photos on the member's phone imported a photo the member took with the phone's camera app
  And the phone has no network connection
  When the member opens the photo in the viewer
  Then the viewer shows the photo sharp at the full size of the screen
```

- **Notes:** a photo whose file is not on the phone needs the network for sizes above the phone's ceiling (RESIDENCY-005 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md)).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-038] A member finds none of Photos' previews in the phone's gallery apps
  Given Photos on the member's phone has made previews of the phone's photos and of photos from the member's other devices
  When the member opens the phone's gallery app
  Then the gallery shows the member's own photos and none of Photos' smaller copies
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOBSYNC-039] A member finds that Photos takes far less space than the camera roll it shows
  Given the camera roll on the member's phone holds 20 GB of photos and videos, and Photos imported all of them
  When the member opens Photos' storage details in Android's app settings
  Then the storage details show Photos using a small fraction of 20 GB
```

- **Notes:** Photos reads the camera roll's files where they are and never copies them. Freeing up space never touches the camera roll (RESIDENCY-040 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md)).
