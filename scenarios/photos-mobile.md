# Photos on the phone: library, viewer, sign-in, and Settings

This file specifies how a member uses Photos on an Android phone: opening the app with or without signing in, the first run, access to the phone's photos, the library grid, the full-screen viewer, the info sheet, captions, deleting a photo, signing in and out, and the Settings screen's Sync and Storage sections. Photos on the phone works offline and needs no sign-in for the photos the phone holds. Signing in buys sync with the member's deployment. Every scenario has the member as its actor.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-mobile-sync.md](photos-mobile-sync.md): what the phone imports from its camera roll, background sync, the phone's own previews, and large video imports
- [photos-library.md](photos-library.md): the web grid's order and the web viewer
- [photos-import-and-processing.md](photos-import-and-processing.md): the details read from each file, and the info rows the phone shares with the web
- [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md): how photos from the phone look in cloud Photos
- starkeep-core [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md): phone sign-in on the platform side, attested keys, and "Sign out all devices"
- starkeep-core [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md): which sizes a phone keeps under its ceilings
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): deletion, the trash window, and restore
- starkeep-core [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md): photos and app rows reaching the member's other devices
- starkeep-core [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md): upload order, retries, and files awaiting upload

## Opening Photos on the phone

### Without signing in

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-001] A member opens Photos on a phone that never signed in and sees the phone's photos
  Given the member chose "Import without signing in" when Photos first ran on the phone
  And the phone has never signed in to a deployment
  When the member opens Photos on the phone
  Then Photos shows the phone's photos in the grid
  And Photos asks for no sign-in
```

- **Notes:** a phone that never signs in is a whole library of its own. Settings offers "Sign in" for sync (PHOTOS-MOB-052).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-002] A member opens Photos with no network connection and sees the library
  Given the member's phone signed in and synced the member's library earlier
  And the phone has no network connection
  When the member opens Photos on the phone
  Then Photos shows the member's photos in the grid with no error
```

- **Notes:** which sizes the phone can show offline is RESIDENCY-005 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md).

### The first run

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-003] A member who opens Photos on a fresh phone is offered sign-in, with a way to import without it
  Given the member installed Photos on a phone and has never opened it
  When the member opens Photos for the first time
  Then Photos reads "Sign in to sync this phone with your Starkeep library. The photos on this phone appear once your library arrives."
  And Photos offers "Sign in to Starkeep Cloud" and "Import without signing in"
  And Android does not yet ask for access to the phone's photos
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-004] A member who chooses "Import without signing in" is warned what importing first risks
  Given Photos shows its first-run screen on the member's phone
  When the member chooses "Import without signing in"
  Then a dialog titled "Import without signing in?" reads "Sign in first if you have used Starkeep on another device or in an earlier install of this app. A phone that imports first and signs in later can bring back photos you deleted, and can overwrite details your other devices recorded."
  And the dialog offers "Cancel" and "Import"
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-005] A member who confirms the import without signing in sees the phone's photos in the grid
  Given the member's phone shows the dialog "Import without signing in?"
  And the phone's camera roll holds a few photos, all taken in the last two weeks
  When the member chooses "Import" and allows Photos to read the phone's photos when Android asks
  Then the grid shows the camera roll's photos
  And the first-run screen does not come back when the member reopens Photos
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-083] A member who cancels the warning finds nothing imported
  Given the member's phone shows the dialog "Import without signing in?"
  When the member chooses "Cancel"
  Then the first-run screen stays, with no photos imported
  And Android does not ask for access to the phone's photos
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-006] A signed-in member on mobile data reads why the phone's own photos are not in the grid yet
  Given the member signed in from the first-run screen on a fresh phone
  And the member's library has not arrived on the phone yet
  And the phone is on mobile data, not Wi-Fi
  When the member looks at the grid
  Then above the grid Photos reads "The photos on this phone appear once your library arrives from the cloud."
  And Photos offers "Sync now" and "Import without waiting"
```

- **Notes:** automatic syncs of the library wait for Wi-Fi ([photos-mobile-sync.md](photos-mobile-sync.md)), so the notice offers a sync on demand.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-085] A member who taps "Sync now" in the notice sees the library start to arrive
  Given the member's phone shows "The photos on this phone appear once your library arrives from the cloud." above the grid
  And the phone is on mobile data
  When the member taps "Sync now" in the notice
  Then the notice reads "Syncing your library. The photos on this phone appear once your library arrives." with a spinner in place of the button
  And photos from the member's other devices start to appear in the grid
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-086] A signed-in member sees the phone's own photos join the grid once the library arrives
  Given the member signed in from the first-run screen on a fresh phone whose camera roll holds a few photos, all taken in the last two weeks
  And a sync of the member's library is running on the phone
  When the member waits until the notice above the grid goes away, and allows Photos to read the phone's photos when Android asks
  Then the grid shows the camera roll's photos beside the photos from the member's other devices
```

- **Notes:** a photo the member deleted on another device stays deleted, because the phone knows of the deletion before it imports. What an import brings in belongs to [photos-mobile-sync.md](photos-mobile-sync.md).

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-007] A member who chooses "Import without waiting" is warned what importing early risks
  Given the member's phone shows the notice that the photos on this phone appear once the library arrives
  When the member chooses "Import without waiting"
  Then a dialog titled "Import before your library arrives?" reads "Your library tells this phone which of its photos your other devices already hold, and which ones you deleted. Importing before it arrives can bring back photos you deleted, and can overwrite details your other devices recorded."
  And the dialog offers "Cancel" and "Import"
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-084] A member who confirms the early import sees the phone's photos before the library arrives
  Given the member's phone shows the dialog "Import before your library arrives?"
  And the phone's camera roll holds a few photos, all taken in the last two weeks
  When the member chooses "Import" and allows Photos to read the phone's photos when Android asks
  Then the grid shows the camera roll's photos
  And the notice above the grid goes away
```

### Access to the phone's photos

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-008] A member who refused photo access sees a prompt above the grid
  Given the member refused when Android asked whether Photos may read the phone's photos
  And Android will still ask again
  When the member opens Photos again and refuses once more when Android asks
  Then above the grid Photos reads "Starkeep needs access to your photos to add them to your library."
  And the prompt offers "Allow access"
```

- **Notes:** Photos asks Android for access once each time it opens while Android still allows the question. Without the prompt a refusal would last until the next launch.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-087] A member who taps "Allow access" and allows it sees the prompt leave and the photos arrive
  Given Photos shows "Starkeep needs access to your photos to add them to your library." above the grid
  And the phone's camera roll holds photos
  When the member taps "Allow access" and allows access when Android asks
  Then the prompt leaves the grid
  And the grid shows the camera roll's photos
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-009] A member whom Android no longer asks gets a button to the phone's settings
  Given the member refused photo access for Photos until Android stopped asking
  When the member opens Photos
  Then the prompt above the grid offers "Open settings" in place of "Allow access"
  And Android does not ask for access when Photos opens
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-010] A member who allows access in the phone's settings sees the prompt leave on returning
  Given Photos shows its photo access prompt with "Open settings"
  And the phone's camera roll holds photos
  When the member taps "Open settings", allows Photos to read photos in the phone's settings, and returns to Photos
  Then the prompt leaves the grid
  And the grid shows the camera roll's photos
```

## The library grid

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-011] A member sees the photos two to a row in square tiles, the most recently taken first
  Given the member's library holds "IMG_0001.jpg" taken on 20 November 2026, "IMG_0002.jpg" taken on 21 November, and "IMG_0003.jpg" taken on 22 November
  And the member holds the phone upright
  When the member opens Photos
  Then the first row shows "IMG_0003.jpg" and then "IMG_0002.jpg", and the second row shows "IMG_0001.jpg"
  And each photo sits in a square tile, the two tiles of a row filling the screen's width
```

- **Notes:** each tile shows the middle of its photo, cropped to the square. The phone's grid follows the web's order, and photos with no date taken follow PHOTOS-LIB-005 in [photos-library.md](photos-library.md).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-012] A member who turns the phone sideways sees four tiles to a row across the whole screen
  Given the member has Photos' grid open with the phone upright
  When the member turns the phone sideways
  Then each row of the grid holds four square tiles across the screen's width
  And the app bar and the phone's status and navigation bars hide, so only photos show
```

- **Notes:** the menu, and so Settings, is reachable only with the phone upright.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-013] A member sees a video's tile marked with a play mark and the video's length
  Given the member's library holds a video 42 seconds long
  When the member scrolls the video into view in the grid
  Then the video's tile carries the mark "▶ 0:42" in its corner
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-014] A member sees a video whose length is unknown marked "▶ video"
  Given the member's library holds a video whose length no device has measured yet
  When the member scrolls the video into view in the grid
  Then the video's tile carries the mark "▶ video" in its corner
```

- **Notes:** the phone never marks such a video "0:00", which would describe a broken file.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-015] A member sees a Motion Photo's tile marked "◉ motion"
  Given the member's library holds a Motion Photo taken with the phone's camera
  When the member scrolls the photo into view in the grid
  Then the photo's tile carries the mark "◉ motion" in its corner
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-016] A member sees a blurred preview in a tile until the photo's picture loads
  Given the member's library holds a photo whose picture has not loaded on the phone yet
  And the phone holds the photo's blurred preview, which arrives with the photo's details
  When the member scrolls the photo into view in the grid
  Then the tile shows a blurred version of the photo at once
  And the photo's picture replaces the blurred version when it loads
```

- **Notes:** the web grid does the same (PHOTOS-IMPORT-025 in [photos-import-and-processing.md](photos-import-and-processing.md)).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-017] A member opens a photo whose files are not on the phone and sees it once it downloads
  Given the member set the phone's photo ceiling to "None" in Settings
  And a photo from the member's computer reached the phone's library after that
  And the phone has a network connection
  When the member taps the photo's tile
  Then the viewer shows the photo once the size for the phone's screen downloads
```

- **Notes:** what the viewer shows while the photo downloads, and with no network connection, is PHOTOS-MOB-030.

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-018] A member learns what the mark on a tile with nothing on the phone means
  Given the member set the phone's photo ceiling to "None" in Settings
  And a photo from the member's computer reached the phone's library after that
  When the member scrolls the photo into view in the grid
  Then the photo's tile carries a cloud mark that reads as "stored in the cloud, opens with a network connection"
```

- **Notes:** Implementation gap: the tile carries a bare "◇" with no explanation anywhere in Photos.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-019] A member with an empty library reads "No photos yet."
  Given the member chose "Import without signing in" when Photos first ran on the phone
  And the phone's camera roll holds no photos
  When the member opens Photos
  Then the grid reads "No photos yet."
```

- **Notes:** until the library's first read finishes, the grid reads "Loading…" instead.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-020] A member who scrolls to the end of the loaded photos sees more load
  Given the member's library on the phone holds 500 photos
  When the member scrolls down past the photos Photos first showed
  Then a spinner shows below the last tile while more photos load
  And the next photos appear below, in the grid's order, until the member reaches the library's oldest photo
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-021] A member who pulls down on the grid sees a photo just taken with the camera appear
  Given the member has Photos open on the phone
  And the member took a photo with the phone's camera app a moment ago, and the grid does not show it yet
  When the member pulls down on the grid
  Then the new photo appears at the top of the grid
```

- **Notes:** the pull also syncs under the phone's automatic rules, which belong to [photos-mobile-sync.md](photos-mobile-sync.md).

## The viewer

### Opening and closing

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-022] A member taps a photo and sees it full screen with a back arrow and an info button
  Given the member has Photos' grid open with the phone upright
  When the member taps a photo's tile
  Then the photo fills the space between a top bar and a footer, on black, in the middle of the screen
  And the top bar holds a back arrow, and the footer holds the info button
```

- **Notes:** a Motion Photo's footer also holds the "Motion" control (PHOTOS-MOB-035). Nothing draws over a still photo.

```gherkin
@mobile
@intent:confirmed
Scenario Outline: [PHOTOS-MOB-023] A member closes the viewer with the back arrow or Android Back and sees the grid where it was
  Given the member scrolled down the grid and opened a photo
  When the member <closes>
  Then the viewer closes and the grid shows the same photos it showed before the member opened the photo

  Examples:
    | closes                             |
    | taps the viewer's back arrow       |
    | presses the phone's Back button    |
```

### Moving between photos

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-024] A member swipes to the next and the previous photo in the grid's order
  Given the member opened "IMG_0002.jpg", which sits between "IMG_0003.jpg" and "IMG_0001.jpg" in the grid
  When the member swipes left, and then swipes right twice
  Then the viewer shows "IMG_0001.jpg" after the first swipe, "IMG_0002.jpg" after the second, and "IMG_0003.jpg" after the third
  And each photo follows the member's finger during the swipe
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-025] A member who swipes near the end of the loaded photos keeps going into the rest of the library
  Given the member's library on the phone holds 500 photos
  And the member opened the last photo the grid has loaded
  When the member keeps swiping left
  Then the viewer moves on to older photos the grid had not loaded, until it reaches the library's oldest photo
```

### The picture

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-026] A member taps the photo to hide the controls and taps again to bring them back, and the photo stays in place
  Given the member has a still photo open in the viewer with the phone upright
  When the member taps the photo, and then taps it again
  Then after the first tap only the photo shows on black, at the same size and in the same place
  And after the second tap the back arrow and the info button show again
```

- **Notes:** the choice holds while the member swipes to other photos and turns the phone. Opening the viewer again starts with the controls showing.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-027] A member who turns the phone sideways sees the photo fill the screen with only a back arrow
  Given the member has a photo open in the viewer with the phone upright
  When the member turns the phone sideways
  Then the photo fills the whole screen, with the phone's status and navigation bars hidden
  And the only control is a back arrow at the top left, over the photo
```

- **Notes:** the info button and the "Motion" control show only with the phone upright.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-028] A member who opens a photo on the phone never sees a blank screen before it sharpens
  Given the member's phone holds the photo's grid size and a larger size for the screen
  When the member taps the photo's tile
  Then the viewer shows the photo at once, never a blank screen
  And the photo sharpens in place, with no flash, once the larger size draws
```

- **Notes:** the web viewer does the same (PHOTOS-LIB-046 in [photos-library.md](photos-library.md)).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-029] A member whose photo does not draw within two seconds reads "Having trouble loading this photo"
  Given the member's phone holds only one size of a photo, and the phone cannot draw that size
  When the member opens the photo in the viewer
  Then the viewer reads "Having trouble loading this photo" no more than two seconds later
```

- **Notes:** a size that fails to decode outright shows the note at once. When a smaller size already drew, the viewer keeps showing that size and shows no note.

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-030] A member who opens a photo with nothing on the phone and no network connection learns why it does not show
  Given the member set the phone's photo ceiling to "None" in Settings
  And a photo from the member's computer reached the phone's library after that
  And the phone has no network connection
  When the member taps the photo's tile
  Then the viewer reads "This photo is not on this phone. Connect to a network to view it."
```

- **Notes:** Implementation gap: the viewer reads "This record's bytes are not on this device.", which names neither the photo nor the remedy.

### Videos and Motion Photos

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-031] A member opens a video on a still frame, and the video plays only when the member taps play
  Given the member's library holds a video
  When the member taps the video's tile
  Then the viewer shows a still frame from the video's first second with a play button over it
  And the video does not start until the member taps the play button
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-032] A member sees the back arrow and the info button hide while a video plays and return when it pauses
  Given the member started a video in the viewer
  When the member pauses the video with the phone's own video controls
  Then the back arrow and the info button, hidden while the video played, show again
```

- **Notes:** the phone's own controls play, pause, and scrub the video.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-033] A member plays a video whose files are not on the phone once it downloads
  Given the member's library holds a video from the member's computer whose copies are not on the phone
  And the phone has a network connection
  When the member opens the video and taps the play button
  Then the play button reads "Loading…" while the video downloads
  And the video then plays
```

- **Notes:** the phone downloads the smallest copy that fills the screen, and the original only for a video no device has made a smaller copy of. Playing a video needs the network by default (RESIDENCY-006 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md)).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-034] A member who taps play on a video not on the phone with no network connection learns why it does not play
  Given the member's library holds a video from the member's computer whose copies are not on the phone
  And the phone has no network connection
  When the member opens the video and taps the play button
  Then the viewer reads that the video needs a network connection to play
```

- **Notes:** Implementation gap: the play button shows "Loading…" and then the play button again, with no message.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-035] A member plays a Motion Photo's movement with "Motion" and stops it with "Stop"
  Given the member opened a Motion Photo in the viewer with the phone upright
  When the member taps "Motion" in the footer, and later taps "Stop"
  Then the photo moves after the first tap, and the control reads "Stop"
  And after the second tap the still photo shows again, and the control reads "Motion"
```

- **Notes:** a swipe to another photo stops the movement too. A photo with no movement shows no "Motion" control.

## Photo info

```gherkin
@mobile
@intent:confirmed
Scenario Outline: [PHOTOS-MOB-036] A member closes the info sheet with its close button, a tap outside it, or Back
  Given the member tapped the info button on a photo in the viewer, and the sheet titled "Photo info" covers the lower part of the screen
  When the member <closes>
  Then the sheet closes and the photo shows again in the viewer

  Examples:
    | closes                                  |
    | taps the sheet's close button           |
    | taps the photo above the sheet          |
    | presses the phone's Back button         |
```

- **Notes:** which details the sheet lists, in which order, and which it leaves out are PHOTOS-IMPORT-021 and PHOTOS-IMPORT-024 in [photos-import-and-processing.md](photos-import-and-processing.md).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-037] A member reads the photo's type and content hash at the end of the info sheet
  Given the member's library holds the JPEG photo "IMG_0042.jpg"
  When the member opens the photo's info sheet on the phone
  Then after the shared details the sheet lists "Type" as "image/jpeg" and "Content hash" with the photo's full hash
  And the member can select the hash to copy it
```

- **Notes:** a file with no content hash shows no "Content hash" row. These two rows appear on the phone only.

## Captions

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-038] A member sees a photo's caption over the bottom of the photo in the viewer
  Given the member's photo carries the caption "Lunch at the lake"
  When the member opens the photo in the viewer on the phone
  Then "Lunch at the lake" shows over the bottom of the photo, above the footer
```

- **Notes:** a caption longer than four lines shows its first four. The caption hides with the other controls when the member taps the photo (PHOTOS-MOB-026).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-039] A member adds a caption on the phone and sees it on the photo
  Given the member's phone is signed in and has synced captions since signing in
  And the member has a photo with no caption open in the info sheet
  When the member taps "Edit caption", types "Lunch at the lake", and taps "Save"
  Then the sheet shows "Lunch at the lake" above the photo's details
```

- **Notes:** the button reads "Saving…" while the caption saves. Once the member closes the sheet, the viewer shows the caption over the photo (PHOTOS-MOB-038). Captions are Photos' own data and sync like the app's other rows (SYNC-015 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md)).

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-040] A member who cancels an edit keeps the caption as it was
  Given the member's photo carries the caption "Lunch at the lake"
  And the member tapped "Edit caption" in the photo's info sheet and typed "Dinner"
  When the member taps "Cancel"
  Then the sheet shows "Lunch at the lake"
  And the viewer still shows "Lunch at the lake" over the photo
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-041] A member who saves an empty caption sees the caption leave the photo
  Given the member's phone is signed in and has synced captions since signing in
  And the member's photo carries the caption "Lunch at the lake"
  When the member taps "Edit caption", deletes all the text, and taps "Save"
  Then the sheet shows no caption above the photo's details
  And the viewer shows no caption over the photo
```

- **Notes:** the web clears a caption the same way (PHOTOS-LIB-058 in [photos-library.md](photos-library.md)).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-042] A member typing a caption on the phone sees how close the caption is to 2,000 characters
  Given the member's phone is signed in and has synced captions since signing in
  And the member tapped "Edit caption" in a photo's info sheet
  When the member pastes 2,500 characters into the caption field
  Then the field holds the first 2,000 characters
  And a counter under the field shows that no characters remain
```

- **Notes:** Implementation gap: the field stops at 2,000 characters with no counter, so the member does not learn why the text was cut. The web's caption limit is PHOTOS-LIB-061 in [photos-library.md](photos-library.md).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-043] A member whose phone has not yet synced captions reads why "Edit caption" is unavailable
  Given the member signed the phone in a moment ago
  And the phone has had no network connection since the sign-in
  When the member opens a photo's info sheet
  Then "Edit caption" is greyed out and does nothing when tapped
  And the sheet reads "Captions can be edited once this phone has synced them."
```

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-044] A member on a phone that is not signed in captions a photo
  Given the member chose "Import without signing in" when Photos first ran on the phone
  And the phone has never signed in to a deployment
  When the member opens a photo's info sheet, taps "Edit caption", types "Lunch at the lake", and taps "Save"
  Then the viewer shows "Lunch at the lake" over the photo
```

- **Notes:** Implementation gap: "Edit caption" is greyed out on a phone that is not signed in, and the sheet reads "Sign in to edit captions."

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-045] A member sees a caption saved on the phone over mobile data in cloud Photos
  Given the member's phone is signed in and has synced captions since signing in
  And the phone is on mobile data, not Wi-Fi
  When the member saves the caption "Lunch at the lake" on a photo on the phone, and a minute later opens the same photo in cloud Photos
  Then cloud Photos shows "Lunch at the lake" on the photo
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-046] A member sees a caption written in cloud Photos on the phone after pulling down on the grid
  Given the member's phone is signed in, has synced captions since signing in, and is on Wi-Fi
  And the member saved the caption "Lunch at the lake" on a photo in cloud Photos
  When the member pulls down on the grid on the phone, and then opens the photo
  Then the viewer shows "Lunch at the lake" over the photo
```

## Deleting a photo

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-047] A member deletes a photo from the info sheet after confirming, and the photo leaves the grid
  Given the member's library holds the photo "IMG_0042.jpg", which came from the member's computer
  And the member has the photo open in the viewer on the phone
  When the member taps "Delete" in the photo's info sheet, and taps "Delete" in the question titled "Delete IMG_0042.jpg?"
  Then the sheet and the viewer close
  And "IMG_0042.jpg" is gone from the grid
```

- **Notes:** the deletion reaches the member's other devices like any deletion (SHARED-107 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). What the question says about restoring is PHOTOS-MOB-051.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-048] A member who cancels the phone's delete question keeps the photo
  Given the member tapped "Delete" in the info sheet of the photo "IMG_0042.jpg"
  When the member taps "Cancel" in the question titled "Delete IMG_0042.jpg?"
  Then the info sheet stays open on the photo
  And the photo stays in the grid
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-049] A member who deletes a photo the phone took is asked by Android to move its file to the phone's trash
  Given the member took the photo "PXL_20261120.jpg" with the phone's camera, and Photos on the phone shows it
  When the member deletes the photo from its info sheet and confirms the question
  Then the photo leaves Photos' grid
  And Android asks whether to move the photo's file to the phone's trash
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-050] A member who declines Android's request keeps the file in the camera roll, and the photo stays out of Photos
  Given the member deleted the phone's own photo "PXL_20261120.jpg" in Photos
  And Android asks whether to move the photo's file to the phone's trash
  When the member declines Android's request, and later pulls down on Photos' grid
  Then the phone's gallery app still shows the photo
  And Photos' grid still does not show the photo
```

- **Notes:** the question before the delete says that Android then asks about the phone's file.

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-051] A member who deletes on the phone is told of a restore place the member can reach
  Given the member uses Photos on the phone and in the cloud, and runs Drive on no computer
  When the member taps "Delete" in a photo's info sheet on the phone
  Then the question names a place where this member can restore the photo
```

- **Notes:** the web's delete question has the same doubt (PHOTOS-LIB-065 in [photos-library.md](photos-library.md)).

## Signing in

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-052] A member signs the phone in from Settings and reads the cloud and the account there
  Given a cloud operator registered Photos for phones on the member's deployment
  And the member's cloud operator sent the address "https://d111111abcdef8.cloudfront.net"
  And the member's phone is not signed in
  When the member taps "Sign in" in Settings, types the address, taps "Sign in", and signs in on the deployment's sign-in page in the phone's browser
  Then Photos opens on the grid again
  And Settings reads "Signed in to d111111abcdef8.cloudfront.net as " followed by the member's email address
```

- **Notes:** the sign-in screen reads "Sync this phone with your cloud" and "Enter the cloud's address your admin sent. You sign in on your cloud's own page, in the browser." Photos never sees the password. The platform side of the sign-in is ACCESS-084 and ACCESS-087 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md).

```gherkin
@mobile
@intent:confirmed
Scenario Outline: [PHOTOS-MOB-053] A member who types an address Photos cannot use reads how to fix it
  Given the member opened the sign-in screen from Settings
  When the member types "<address>" and taps "Sign in"
  Then the sign-in screen reads "<message>"
  And the phone's browser does not open

  Examples:
    | address                               | message                                                             |
    | d111111abcdef8.cloudfront.net         | Enter the cloud address your admin sent, starting with https://.   |
    | my cloud                              | Enter the cloud address your admin sent, starting with https://.   |
    | http://d111111abcdef8.cloudfront.net  | The cloud address must use https.                                   |
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-054] A member cannot tap "Sign in" until an address is typed
  Given the member opened the sign-in screen from Settings
  When the member taps "Sign in" with the address field empty
  Then the dimmed "Sign in" button does nothing
```

- **Notes:** the button brightens once the member types an address.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-055] A member who closes the sign-in page returns to the sign-in screen with no error
  Given the member typed the deployment's address on the sign-in screen and tapped "Sign in"
  And the deployment's sign-in page is open in the phone's browser
  When the member closes the page without signing in
  Then Photos shows the sign-in screen again with the address still typed and no error
  And Settings still offers "Sign in"
```

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-056] A member who chooses Cancel returns to Photos still signed out
  Given the member opened the sign-in screen from Settings on a phone that is not signed in
  When the member taps "Cancel"
  Then Photos shows the grid with the phone's photos
  And Settings still offers "Sign in"
```

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-057] A member who types the address of a site that is not a Starkeep cloud learns that it is not one
  Given the member opened the sign-in screen from Settings
  When the member types "https://example.com" and taps "Sign in"
  Then the sign-in screen says in plain words that the address is not a Starkeep deployment and asks the member to check the address the cloud operator sent
```

- **Notes:** Implementation gap: the screen reads "The cloud answered 404 when asked how to sign in".

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-058] A member who tries to sign in with no network connection learns that the phone is offline
  Given the member opened the sign-in screen from Settings
  And the phone has no network connection
  When the member types the deployment's address and taps "Sign in"
  Then the sign-in screen says that the phone has no network connection and that the member can try again once it does
```

- **Notes:** Implementation gap: the screen shows the network library's raw error, "Network request failed".

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-059] A member on a deployment where Photos is not set up for phones learns whom to ask
  Given the member's deployment offers phone sign-in, but no cloud operator registered Photos for phones there
  When the member types the deployment's address on the sign-in screen and taps "Sign in"
  Then Photos says that Photos is not set up for phones on this deployment and that the member's cloud operator can set it up
```

- **Notes:** Implementation gap: the phone's browser opens the sign-in page, which ends on an error page because it cannot return to Photos, and closing the page brings the member back with no message. The platform side is ACCESS-085 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md).

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-060] A member on a deployment that predates phone sign-in learns whom to ask
  Given the member's deployment runs a build from before phones could sign in
  When the member types the deployment's address on the sign-in screen and taps "Sign in"
  Then Photos says that this deployment does not support phone sign-in yet and that the member's cloud operator can update it
```

- **Notes:** Implementation gap: the screen reads "This cloud does not offer sign-in to mobile apps yet", which names no next step.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-061] A member whose account has no library reads that a cloud operator must give it one, and stays signed out
  Given the member's account on the deployment has no cloud operator rights and does not belong to the data group
  When the member signs in on the phone with that account
  Then the sign-in screen reads "This account has no library to sync. Ask your admin to give it one."
  And Settings still offers "Sign in"
```

- **Notes:** the computer refuses such an account the same way (ACCESS-006 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md)).

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-088] A member whose account has cloud operator rights but sits outside the data group signs the phone in and syncs the member's own library
  Given the member's account has cloud operator rights and does not belong to the data group
  When the member signs the phone in to "https://d111111abcdef8.cloudfront.net" with that account
  Then Settings reads "Signed in to d111111abcdef8.cloudfront.net as " followed by the member's email address
  And Photos on the phone shows the photos of the member's own library
```

- **Notes:** every account with cloud operator rights holds a library of its own (ACCESS-004 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md)). Implementation gap: the phone refuses the account with "This account has no library to sync. Ask your admin to give it one."

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-062] A member whose phone cannot prove it runs the genuine Photos app reads why, and stays signed out
  Given the member's phone has an unlocked bootloader
  When the member signs in on the phone
  Then the sign-in screen reads "The cloud could not confirm this is Starkeep Photos: The device's operating system is not verified"
  And Settings still offers "Sign in"
```

- **Notes:** a phone with an unlocked bootloader reports its operating system as unverified, and the deployment checks that before the lock state, so the member reads the operating-system reason. The other refusals of the phone's key are ACCESS-088 to ACCESS-090 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md), and each shows the deployment's own reason after the same opening words.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-063] A member's first sign-in brings the photos the phone imported earlier into the member's cloud library
  Given the member chose "Import without signing in" when Photos first ran on the phone, and the phone imported 20 photos
  When the member signs the phone in for the first time and leaves Photos open on Wi-Fi
  Then cloud Photos shows the 20 photos
```

- **Notes:** from then on the phone's library belongs to that member, and a sign-in with another account is PHOTOS-MOB-064. The computer does the same at its first sign-in (ACCESS-077 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md)).

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-064] A member who signs in as another account on a phone whose library belongs to someone else learns how to go on
  Given another member signed this phone in earlier and then signed it out
  When the member signs the phone in with the member's own account
  Then the sign-in screen says that this phone's library belongs to another account
  And the message names a step the member can take in Photos to use the phone
```

- **Notes:** Implementation gap: the screen reads "This phone's library belongs to another account. Sign in as that account, or reset this phone's library first.", and Photos offers no way to reset the phone's library.

## Signing out and ended sign-ins

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-065] A member who taps "Sign out" once is asked to tap again
  Given the member's phone is signed in and no sync is running
  When the member taps "Sign out" in Settings
  Then the line reads "Tap again to sign out. Syncing stops until you sign in again."
  And the phone stays signed in
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-089] A member who taps "Sign out" again is signed out and keeps every photo on the phone
  Given Settings reads "Tap again to sign out. Syncing stops until you sign in again."
  When the member taps that line
  Then Settings reads "Sign in with the Starkeep account your admin created to sync this phone's photos." with a "Sign in" button, and shows no Sync section
  And the grid still shows every photo the phone showed before
```

- **Notes:** the phone ends the sign-in at the deployment as soon as the deployment answers, at the next launch if it is offline.

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-066] A member who taps "Sign out" while a sync runs signs out
  Given the member's phone is signed in and Settings shows "Syncing…"
  When the member taps "Sign out", and then taps the line again
  Then the sync stops and the phone signs out
  And Settings offers "Sign in"
```

- **Notes:** Implementation gap: "Sign out" does nothing while a sync runs, and nothing on screen says why.

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-067] A member whose sign-in a cloud operator ended reads in plain words why syncing stopped
  Given a cloud operator chose "Sign out all devices" for the member
  And the member has kept Photos open on the phone, on Wi-Fi, for 20 minutes since
  When the member opens Settings
  Then Settings says that the member's sign-in ended and that signing in again resumes syncing, with no error text from the sign-in service
  And Settings offers "Sign in"
```

- **Notes:** the sign-out itself is ACCESS-022 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md). Implementation gap: Settings reads "Your sign-in ended (" followed by the sign-in service's own error text and "). Sign in again to keep syncing.", and nothing outside Settings says that syncing stopped.

## Settings

### Opening Settings

```gherkin
@mobile
@intent:confirmed
Scenario Outline: [PHOTOS-MOB-068] A member opens Settings from the menu and closes it with the back arrow or Android Back
  Given the member scrolled down the grid with the phone upright
  When the member taps the menu button, taps "Settings", and then <closes>
  Then Settings closes and the grid shows the same photos it showed before

  Examples:
    | closes                                 |
    | taps the back arrow in Settings' bar   |
    | presses the phone's Back button        |
```

- **Notes:** Settings holds the Account, Sync, and Storage sections. The menu holds only "Settings".

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-069] A member on a phone that is not signed in sees no Sync section
  Given the member's phone is not signed in
  When the member opens Settings
  Then Settings shows the Account and Storage sections and no Sync section
```

### Sync

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-070] A member taps "Sync now" and sees "Syncing…" until the sync ends
  Given the member's phone is signed in and on Wi-Fi
  When the member taps "Sync now" in Settings
  Then the button reads "Syncing…" and takes no taps while the sync runs
  And the button reads "Sync now" again once the sync ends
```

- **Notes:** a sync that ends short of finishing names the reason under the button.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-071] A member on Wi-Fi with Photos open sees waiting files upload without tapping anything
  Given the member's phone is signed in and on Wi-Fi, with Photos open
  And 3 of the phone's files, 12 MB in all, wait to upload
  When the member opens Settings
  Then the Sync section reads "Uploading 3 files (12 MB)"
  And the line goes away once the files reach the cloud
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-072] A member on mobile data reads that the waiting files upload on Wi-Fi
  Given the member's phone is signed in and on mobile data, with Photos open
  And 3 of the phone's files, 12 MB in all, wait to upload
  When the member opens Settings
  Then the Sync section reads "3 files (12 MB) to upload on Wi-Fi"
```

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-073] A member on mobile data who taps "Sync now" sends the waiting files too
  Given the member's phone is signed in and on mobile data, with Photos open
  And Settings reads "3 files (12 MB) to upload on Wi-Fi"
  When the member taps "Sync now"
  Then the button reads "Syncing…" until the 3 files have uploaded
  And the line "3 files (12 MB) to upload on Wi-Fi" goes away
```

- **Notes:** automatic syncs in the background follow their own rules ([photos-mobile-sync.md](photos-mobile-sync.md)).

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-074] A member whose deployment is busy while files upload sees the uploads carry on with no alarm
  Given the member's phone is signed in and on Wi-Fi, with Photos open
  And 3 of the phone's files, 12 MB in all, wait to upload
  And the member's deployment is busy and turns away the phone's upload requests for a minute
  When the member opens Settings
  Then the Sync section reads "Uploading 3 files (12 MB)"
  And the line goes away once the deployment answers again and the files reach the cloud
```

- **Notes:** Implementation gap: the line reads "Waiting for the network to upload 3 files (12 MB)", though the phone's network works.

```gherkin
@mobile @cloud
@intent:confirmed
Scenario: [PHOTOS-MOB-075] A member reads how many photos the phone can no longer upload because they left the camera roll
  Given the member's phone is signed in
  And the member deleted 2 photos from the phone's camera roll with another app before their originals uploaded
  And no other file waits to upload
  When the member opens Settings
  Then the Sync section reads "2 missing from the camera roll"
```

- **Notes:** what the member's other devices show for those photos is BYTES-011 in starkeep-core's [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md).

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-076] A member who taps "Sync now" with no network connection learns that the phone is offline
  Given the member's phone is signed in
  And the phone has no network connection
  When the member taps "Sync now" in Settings
  Then the Sync section says that the phone has no network connection and that syncing resumes once it does
```

- **Notes:** Implementation gap: the Sync section shows the network library's raw error, such as "TypeError: Network request failed".

```gherkin
@mobile @cloud
@intent:unclear
Scenario: [PHOTOS-MOB-077] A member who taps "Sync now" while the deployment is busy sees the sync finish with no error
  Given the member's phone is signed in and on Wi-Fi
  And the member's deployment is busy and turns away requests for a minute
  When the member taps "Sync now" in Settings
  Then the button reads "Syncing…" while the phone tries again quietly
  And the sync finishes with no error once the deployment answers
```

- **Notes:** Implementation gap: the sync stops at the first refused request, and the Sync section shows the refused request as raw text, with its path "/sync/exchange" and the status code. A busy deployment is CLOUD-RUN-020 and its neighbours in starkeep-core's [cloud-runtime.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/cloud-runtime.md).

### Storage

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-078] A member reads how much the phone holds, by kind of file, largest first
  Given the phone holds 1.2 GB of photo previews and 300 MB of video previews, and no other files from the library
  When the member opens Settings
  Then the Storage section reads "1.5 GB held on this device"
  And below it lists "Photo previews" with "1.2 GB" and then "Video previews" with "300 MB"
```

- **Notes:** a kind of file the phone holds none of is not listed. Files no preview can stand in for show as "Other files, kept on every device", and full-size files as "Photo originals" and "Video originals".

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-079] A member sees the phone's photo and video ceilings, with the defaults chosen
  Given nobody changed the phone's ceilings
  And the member's library uses the default preview sizes
  When the member opens Settings
  Then under "Sync-down ceilings" the "Photos (default)" choices read "None", "320 px", "640 px", "1280 px", "2560 px", and "4272 px (canonical)", with "1280 px" chosen
  And the "Videos (default)" choices read "None", "2000 kbps", and "4800 kbps (canonical)", with "None" chosen
```

- **Notes:** the choices read as admin-web's "Sync-down ceilings" do on a computer. What each ceiling keeps on the phone is RESIDENCY-005 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-080] A member learns from Settings what a ceiling decides
  Given nobody changed the phone's ceilings
  When the member opens Settings
  Then the Storage section explains in one plain sentence that the phone keeps every photo and video up to the chosen size for viewing offline, and fetches larger sizes when the member opens them
```

- **Notes:** Implementation gap: the section shows "Sync-down ceilings" and the choices with no explanation.

```gherkin
@mobile
@intent:confirmed
Scenario: [PHOTOS-MOB-081] A member chooses another photo ceiling and finds it still chosen after reopening Photos
  Given nobody changed the phone's ceilings
  When the member taps "2560 px" under "Photos (default)" in Settings, and later closes and reopens Photos
  Then Settings shows "2560 px" chosen under "Photos", without "(default)"
```

- **Notes:** what the phone downloads after a raised ceiling is RESIDENCY-023 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md).

```gherkin
@mobile
@intent:unclear
Scenario: [PHOTOS-MOB-082] A member who lowers the phone's photo ceiling can free the space the larger sizes took
  Given the member chose "2560 px" under "Photos" in Settings, and the phone holds 2560-pixel previews of the library's photos
  When the member chooses "1280 px" under "Photos"
  Then Settings offers a way to free the space the 2560-pixel previews take
```

- **Notes:** Implementation gap: Settings offers no way to free space, so the phone keeps every size it ever downloaded. Freeing space on a computer is RESIDENCY-024 and RESIDENCY-030 in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md).
