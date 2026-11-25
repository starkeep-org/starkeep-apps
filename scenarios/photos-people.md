# Photos: people

This file specifies Photos' on-device face recognition: the Face recognition panel, the one-time model download, the scan that finds faces in the library, the viewer's face boxes, the People view where the member names, merges, and splits groups, and sharing names and face counts with other apps. The member uses Photos on a computer, where the feature runs, and cloud Photos, where the feature is absent. The local operator deletes Photos' kept data in admin-web. The app developer builds another app that reads the face labels Photos shares. Photos on the phone has no people features.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-library.md](photos-library.md): the library grid, the viewer and its buttons, and the Settings menu
- [photos-import-and-processing.md](photos-import-and-processing.md): the previews Photos makes on a computer, which the scan reads
- [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md): cloud Photos
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): labels, which carry the names and face counts Photos shares
- starkeep-core [app-lifecycle.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/app-lifecycle.md): uninstalling, Delete data, and reinstalling an app

## Opening face recognition

Face recognition is off until the member turns it on. On a computer, the Settings menu offers "On-device face recognition" under "Library", which opens the Face recognition panel.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-001] A member opens "On-device face recognition" from Settings and sees the Face recognition panel
  Given the member has Photos open on a computer
  When the member opens Settings and clicks "On-device face recognition" under "Library"
  Then the Settings menu closes and a panel titled "Face recognition" opens over the library
  And the panel closes when the member clicks its "×" button or anywhere outside it
```

- **Notes:** the Settings menu itself belongs to PHOTOS-LIB-069 in [photos-library.md](photos-library.md).

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-002] A member reads in the panel that faces and names stay on this computer unless the member shares them
  Given the member has the Face recognition panel open on a computer
  When the member reads the note under the panel's title
  Then the note says that faces, identity vectors, and names stay on this computer
  And the note says that the names and face counts the member chooses to share with other apps leave this computer
```

- **Notes:** Implementation gap: the note reads "Runs entirely on this device. Faces, identity vectors, and names are stored locally and never sync.", but "Share names and face counts with other apps" (PHOTOS-PEOPLE-055) publishes names as labels on the member's photos, and labels sync with the photos.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-003] A member in cloud Photos finds no face recognition in Settings
  Given the member is signed in to cloud Photos in a browser
  When the member opens Settings
  Then the menu has no "Library" section and no "On-device face recognition" entry
```

- **Notes:** face recognition runs only on the computer that holds the photos and the models. Cloud Photos offers no disabled control, because a disabled control would suggest that the feature is coming.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-004] A member finds face detection and sharing off, and the match threshold at 0.45, before changing anything
  Given the member has downloaded the face models on a computer
  And the member has never changed a face recognition setting
  When the member opens the Face recognition panel
  Then "Detect faces in my photos" is unchecked
  And the "Match threshold" slider reads "0.45"
  And "Share names and face counts with other apps" is unchecked
  And the slider and the sharing checkbox are dimmed and cannot be changed until the member checks "Detect faces in my photos"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-005] A member finds the face recognition settings as left after Photos restarts
  Given the member checked "Detect faces in my photos" and set the match threshold to 0.60
  And Photos has since stopped and started again on the computer
  When the member opens the Face recognition panel
  Then "Detect faces in my photos" is checked
  And the "Match threshold" slider reads "0.60"
```

## Downloading the face models

Face recognition needs two model files that Photos does not ship with. The member downloads them once from the panel, or from a shell. The download is the member's acceptance of the models' licence.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-006] A member reads the download's size and the models' licence before downloading
  Given the member has not downloaded the face models on this computer
  When the member opens the Face recognition panel
  Then the panel says "Face recognition needs a one-time 265 MB model download."
  And the panel says "InsightFace antelopev2 weights — licensed for non-commercial research use only. Downloading them accepts that."
  And the panel offers a "Download 265 MB" button and the line "Or from a shell: pnpm vision:fetch-models"
  And "Detect faces in my photos" cannot be checked yet
```

- **Notes:** the panel counts a megabyte as 1,048,576 bytes, so the two files' 277,589,161 bytes read as 265 MB. `photos/README.md` › "Face recognition" calls the same download "~278 MB".

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-007] A member downloads the models and watches the progress
  Given the member has the Face recognition panel open on a computer without the face models
  When the member presses "Download 265 MB"
  Then the button gives way to "Downloading face models…" with the megabytes received out of 265 MB and a bar that fills
  And the line under the bar names the file in flight, first "scrfd_10g_bnkps.onnx" and then "glintr100.onnx", followed by "— you can close this panel; the download continues."
```

- **Notes:** the panel refreshes the progress every second while the download runs. The download checks each file's SHA-256 before keeping it, and records the licence acceptance beside the files.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-008] A member who closes the panel during the download finds it still running on reopening
  Given the member started the face model download and closed the Face recognition panel
  When the member opens the panel again before the download finishes
  Then the panel shows "Downloading face models…" with more megabytes received than when the member closed it
  And the panel offers no second download
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-009] A member sees which models are installed once the download finishes, and can turn on face detection
  Given the member has the Face recognition panel open while the face model download runs
  When the member waits for the download to finish
  Then the progress gives way to "✓ antelopev2 models installed" with "265 MB" and the line "scrfd_10g_bnkps.onnx · glintr100.onnx", without a reload
  And "Detect faces in my photos" can be checked
```

- **Notes:** the installed line stays in the panel from then on, so the member can always see which models Photos runs. Hovering it shows the folder that holds the files.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-010] A member whose download fails reads why in plain words and can try again
  Given the member's computer loses its network connection while the face model download runs
  When the member looks at the Face recognition panel
  Then the panel says in plain words that the download failed and that the member can try again
  And the panel offers a "Try again" button
  And "Detect faces in my photos" still cannot be checked
```

- **Notes:** Implementation gap: the panel shows "Download failed: " followed by the raw error, such as a fetch error or "SHA-256 mismatch for <file path> …" with both digests. A failed file leaves nothing behind, so "Try again" starts that file over.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-011] A member whose download was cut off by a restart is offered only the part still missing
  Given the face model download had finished "scrfd_10g_bnkps.onnx" when Photos stopped and started again on the computer
  When the member opens the Face recognition panel
  Then the panel says "Face recognition needs a one-time 249 MB model download."
  And the panel offers a "Download 249 MB" button
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-012] A member downloads the models from a shell after accepting the licence
  Given the member has a terminal open in Photos' folder on the computer
  When the member runs `pnpm vision:fetch-models` and answers "y" at "Accept and download? [y/N]"
  Then the command prints the licence notice before the question, and each file's progress after it
  And the command ends with "Done. Enable face detection in the Photos Settings panel."
  And the Face recognition panel shows "✓ antelopev2 models installed"
```

- **Notes:** a file already present at its full size prints "✓ <file> — already installed (<size> MB)" and is not fetched again. `pnpm vision:fetch-models --accept-noncommercial-licence` accepts without the question, for a scripted install.

```gherkin
@local
@intent:confirmed
Scenario Outline: [PHOTOS-PEOPLE-013] A member who declines the licence in a shell, or runs the download without a terminal, gets no models
  Given the member has not downloaded the face models on this computer
  When the member <runs the download>
  Then the command prints the licence notice and <then prints>
  And the command ends with "Declined — no models downloaded."
  And the Face recognition panel still offers the download

  Examples:
    | runs the download                                                                             | then prints                                                                                                  |
    | runs `pnpm vision:fetch-models` in a terminal and answers "n" at "Accept and download? [y/N]" | nothing more before the last line                                                                            |
    | runs `pnpm vision:fetch-models` from a script with no terminal attached                        | "Non-interactive shell — re-run with --accept-noncommercial-licence to accept the licence terms above." |
```

## Scanning the library

The scan reads each photo in the library from a preview size already on the computer, finds the faces in it, and sorts the faces into groups when the scan ends. The Scan card in the Face recognition panel shows the scan's progress and results, and refreshes every second while a scan runs. The examples below use a library of "beach.jpg", which shows one person, "party.jpg", which shows that person and a second person, and "tree.jpg", which shows no one.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-014] A member cannot press "Scan now" while face detection is off
  Given the member has downloaded the face models on a computer
  And "Detect faces in my photos" is unchecked
  When the member opens the Face recognition panel
  Then the Scan card's "Scan now" button is dimmed and cannot be pressed
```

- **Notes:** "Scan now" also stays dimmed until the face models are installed (PHOTOS-PEOPLE-006).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-015] A member scans the library and watches the count of photos read climb
  Given the member's library holds "beach.jpg", "party.jpg", and "tree.jpg", each with its previews on the computer
  And Photos has finished making previews
  And the member has checked "Detect faces in my photos" and never scanned
  When the member presses "Scan now"
  Then the button reads "Stop" while the scan runs
  And the "Faces" line counts up to "3 / 3 processed" without a reload
  And the button reads "Scan now" again once the scan ends
```

- **Notes:** a first scan of about 10,000 photos takes 45 to 60 minutes. The scan runs off Photos' main thread, so the grid stays responsive.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-016] A member reads how many faces, photos with faces, and named groups the scan found
  Given the member scanned a library of "beach.jpg", "party.jpg", and "tree.jpg"
  And the member has named no group
  When the member looks at the Scan card
  Then the "Found" line reads "3 faces in 2 photos · 0 of 2 groups named"
  And the card's People button reads "People (2)"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-017] A member whose scan found one face in one photo reads it in the singular
  Given the member scanned a library that holds only "beach.jpg"
  And the member has named no group
  When the member looks at the Scan card
  Then the "Found" line reads "1 face in 1 photo · 0 of 1 group named"
```

- **Notes:** Implementation gap: the line reads "1 faces in 1 photos · 0 of 1 groups named", because the panel never uses the singular.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-018] A member who scans again sees the photos already read counted as already done
  Given the member scanned a library of "beach.jpg", "party.jpg", and "tree.jpg"
  And no photo has been added or removed since
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "0 / 3 processed · 3 already done"
  And the "Found" line still reads "3 faces in 2 photos"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-019] A member's later scan reads only the photos no scan has read yet
  Given the member scanned a library of "beach.jpg", "party.jpg", and "tree.jpg"
  And the library has since gained "picnic.jpg" and "dog.jpg", which no scan has read, each with its previews on the computer
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "2 / 5 processed · 3 already done"
```

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-020] A member who adds photos after a scan finds their faces without pressing "Scan now" again
  Given the member has checked "Detect faces in my photos" and scanned the library
  When the member adds "picnic.jpg", which shows two people, with "Add Photo"
  Then once Photos has made the previews of "picnic.jpg", the viewer shows a "Faces" button on "picnic.jpg"
  And the member never pressed "Scan now" for it
```

- **Notes:** Implementation gap: only "Scan now" starts a scan, so a new photo's faces wait for the member's next scan.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-021] A member stops a scan and finds groups for the faces found so far
  Given a scan of a library of 1,000 photos is running and has read some of them
  When the member presses "Stop"
  Then the button reads "Scan now" again once Photos finishes the photo it is reading
  And the "Faces" line reads fewer than 1000 photos processed, as in "412 / 1000 processed"
  And People lists groups for the faces found in the photos read before the stop
```

- **Notes:** the next scan counts the photos read before the stop as already done (PHOTOS-PEOPLE-018).

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-022] A member whose Photos restarted during a scan reads that the scan was interrupted
  Given a scan was running when Photos stopped and started again on the computer
  When the member opens the Face recognition panel
  Then the Scan card shows the line "Last run" with "the scan was interrupted — the app restarted while it was running"
  And the button reads "Scan now"
```

- **Notes:** the next scan counts the photos read before the restart as already done, and sorts their faces into groups when it ends. Until then, People holds no groups for those faces.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-023] A member who presses "Scan now" while Photos is still making previews gets the scan once the previews are made
  Given Photos is still making previews for photos the member just added
  And the member has checked "Detect faces in my photos"
  When the member presses "Scan now"
  Then the Scan card says in plain words that the scan starts once Photos has made the new previews
  And the scan starts on its own once the previews are made, and reads the new photos too
```

- **Notes:** Implementation gap: Photos refuses the scan and shows "derivation is running — it produces the size this scan reads, so it goes first. Stop it first if you want to scan against what is already derived." Photos offers no control that stops the making of previews. Photos also makes previews for a while after every start, so a member who opens the panel right after Photos starts meets the refusal.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-024] A member whose scan yields to new photos' previews sees the scan continue on its own afterwards
  Given a scan of the member's library is running
  And new photos reach the computer from the member's phone during the scan
  When the member watches the Scan card
  Then the card says in plain words that the scan waits while Photos makes the new photos' previews
  And the scan continues on its own once the previews are made, and reads the new photos too
```

- **Notes:** Implementation gap: Photos stops the scan when it starts making previews, says nothing, and never restarts it. The button reads "Scan now" again as if the scan had ended.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-025] A member sees photos whose previews have not reached this computer counted as waiting
  Given the member's library holds "beach.jpg", "party.jpg", and "tree.jpg" with their previews on the computer
  And the library holds two photos from the member's phone whose previews have not reached the computer yet
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "3 / 5 processed · 2 waiting for a preview on this machine"
```

- **Notes:** the scan reads only sizes already on the computer and never downloads an original for the purpose. A scan after the two photos' previews arrive reads them.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-026] A member sees a photo that cannot be read counted as failed
  Given the member's library holds "beach.jpg" and "party.jpg" with their previews on the computer
  And the library holds one photo on the computer that Photos cannot decode, such as a damaged file
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "2 / 3 processed · 1 failed"
```

- **Notes:** one unreadable photo does not end the scan. Photos records no result for it, so every later scan tries it again and counts it as failed again while it stays unreadable.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-027] A member who scans a library with videos sees only the photos counted
  Given the member's library holds "beach.jpg", "party.jpg", and "tree.jpg", and the video "clip.mp4", each with its previews on the computer
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "3 / 3 processed", with no failed and no waiting count
```

- **Notes:** Implementation gap: the scan counts "clip.mp4" among the photos to read and hands its video file to the image reader, so the card shows "3 / 4 processed · 1 failed" on every scan, or "· 1 waiting for a preview on this machine" while the computer holds no copy of the video.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-028] A member sees each photo counted once, not once for each of its previews
  Given the member's library holds "beach.jpg" and "party.jpg", each with several preview sizes on the computer
  When the member presses "Scan now" and waits for the scan to end
  Then the "Faces" line reads "2 / 2 processed"
  And the "Found" line reads "3 faces in 2 photos"
```

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-029] A member who deletes a photo sees its faces leave People at once
  Given the member scanned "beach.jpg" and "party.jpg" and named the group of the person in both "Alice"
  And the member has since deleted "beach.jpg"
  When the member opens People
  Then the "Alice" row reads "1 photo"
  And the faces under "Alice" show only the face from "party.jpg"
```

- **Notes:** Implementation gap: the deleted photo's face stays in People, with a tile that cannot load, and keeps counting on the Scan card until the next scan ends. A scan of a library that lists no photos at all keeps every result, because an empty listing can also mean that the library is mid-reinstall.

## Faces in the viewer

On a computer, the viewer offers a "Faces" button on a photo in which the scan found faces. The button draws a box on each face found, and the boxes stay hidden until the member presses it. The viewer's other buttons belong to [photos-library.md](photos-library.md) (PHOTOS-LIB-032).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-030] A member presses "Faces" in the viewer and sees a box on each face found
  Given the member scanned "party.jpg", which shows two people
  And the member has "party.jpg" open in the viewer
  When the member presses "Faces"
  Then a box outlines each of the two faces on the photo
  And the button reads "Faces (2)"
```

- **Notes:** pressing "Faces" again hides the boxes. The boxes keep their place on the faces when the window changes size, and clicks pass through them to the photo.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-031] A member sees a named group's name above its faces in the viewer
  Given the member scanned "party.jpg", which shows two people
  And the member named the group of one of them "Alice" and left the other group unnamed
  When the member opens "party.jpg" in the viewer and presses "Faces"
  Then the box on Alice's face shows "Alice" above it
  And the box on the other face shows no name
```

```gherkin
@local
@intent:confirmed
Scenario Outline: [PHOTOS-PEOPLE-032] A member sees no "Faces" button on a photo that has no faces found or no scan yet
  Given the member's library holds <photo>
  When the member opens the photo in the viewer
  Then the viewer's top line shows no "Faces" button

  Examples:
    | photo                                                    |
    | "tree.jpg", in which the scan found no faces             |
    | "picnic.jpg", which shows two people and no scan has read |
```

- **Notes:** a button that would draw nothing is left out, so it does not take the close button's place on a narrow window (PHOTOS-LIB-039).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-033] A member sees the boxes land on the faces of a photo stored sideways
  Given the member scanned "portrait.jpg", which the camera stored sideways with a tag that turns it upright, and which shows one person
  When the member opens "portrait.jpg" in the viewer and presses "Faces"
  Then the photo shows upright, and the box outlines the person's face
```

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-034] A member who steps to the next photo with the boxes showing finds them showing there too
  Given the member has "party.jpg" open in the viewer with its face boxes showing
  And the next photo in the grid is "beach.jpg", which the scan read and found one face in
  When the member presses the right arrow key
  Then "beach.jpg" opens with its face box showing
  And the button reads "Faces (1)"
```

- **Notes:** Implementation gap: the viewer hides the boxes on every photo change, so the member presses "Faces" again on each photo.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-066] A member in cloud Photos sees no "Faces" button on a photo a computer scanned
  Given the member's computer scanned "party.jpg", which shows two people
  And the member is signed in to cloud Photos in a browser
  When the member opens "party.jpg" in the viewer
  Then the viewer's top line shows no "Faces" button
```

- **Notes:** cloud Photos finds no faces of its own, and it does not show the names and face counts a computer shares.

## Grouping and naming people

When a scan ends, Photos sorts every new face into the group whose faces it matches at the match threshold, or into a new group of its own. The People view lists the groups and lets the member name, merge, split, and rebuild them. The member opens People with the "People (N)" button on the Scan card.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-035] A member opens People from the panel and sees the groups largest first, each with its clearest face
  Given the member scanned "beach.jpg", "party.jpg", and "tree.jpg"
  And the member has named no group
  When the member presses "People (2)" on the Scan card
  Then the Face recognition panel closes and a "People" panel opens
  And the first row is the person in "beach.jpg" and "party.jpg", reading "2 photos", and the second row reads "1 photo"
  And each row shows a square tile of the group's clearest face and a name box reading "Add a name"
```

- **Notes:** groups of equal size list the older group first. A tile shows the face with some of its surroundings, cut from a size already on the computer.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-036] A member with no groups is told how to make them
  Given the member has downloaded the face models and never scanned
  When the member presses "People (0)" on the Scan card
  Then People says "No faces grouped yet. Enable face detection and run a scan from the Face recognition panel."
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-037] A member sees two photos of one person in one group, and another person in a group of their own
  Given the member's library holds "beach.jpg" and "lake.jpg", which show the same person years apart, and "dog.jpg", which shows a different person
  And the member never changed the match threshold from 0.45
  When the member scans the library and opens People
  Then one row reads "2 photos" and holds the faces from "beach.jpg" and "lake.jpg"
  And another row reads "1 photo" and holds the face from "dog.jpg"
```

- **Notes:** on real portraits, two photos of one person matched at 0.81 and different people at 0.29 or less, so the default 0.45 sits between the two with room on both sides.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-038] A member names a group and sees the name counted in the panel
  Given the member has People open with an unnamed group for the person in "beach.jpg" and "party.jpg"
  When the member types "Alice" into the group's name box, presses Enter, closes People, and opens the Face recognition panel from Settings
  Then the "Found" line ends "1 of 2 groups named"
```

- **Notes:** People shows "Alice" in the group's name box when the member opens it again. Clicking outside the name box saves the name too. The viewer shows the name above Alice's faces (PHOTOS-PEOPLE-031).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-039] A member clears a group's name and sees "Add a name" again
  Given the member named a group "Alice"
  When the member deletes the text in the group's name box and presses Enter
  Then the name box reads "Add a name"
  And the viewer shows no name above that person's faces
```

- **Notes:** a name of spaces alone saves as no name.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-040] A member who gives a second group a name already in use is offered to merge the two
  Given the member has People open with a group named "Alice" and an unnamed group that also shows Alice
  When the member types "Alice" into the unnamed group's name box and presses Enter
  Then People offers to merge the two "Alice" groups into one
```

- **Notes:** Implementation gap: People keeps two separate rows named "Alice" and offers nothing.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-041] A member finds a named person's faces from later photos in the named group after the next scan
  Given the member named the group of the person in "beach.jpg" and "party.jpg" "Alice"
  And the member has since added "picnic.jpg", which shows Alice
  When the member scans the library and opens People
  Then the "Alice" row reads "3 photos"
  And the viewer shows "Alice" above her face on "picnic.jpg"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-042] A member merges one group into another and sees one group with both groups' faces
  Given the member has People open with a group "Alice" reading "2 photos" and an unnamed group reading "1 photo" that also shows Alice
  When the member presses "Merge" on the unnamed group and then "Merge into this" on "Alice"
  Then People lists one "Alice" row reading "3 photos"
  And the unnamed row is gone
```

- **Notes:** after the first press, People shows "Pick the group to merge into.", the pressed button reads "Choosing…", and every other row offers "Merge into this". Merging one named group into another keeps the name of the group merged into.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-043] A member who merges a named group into an unnamed one keeps the name
  Given the member has People open with a group "Alice" reading "1 photo" and an unnamed group reading "2 photos" that also shows Alice
  When the member presses "Merge" on "Alice" and then "Merge into this" on the unnamed group
  Then People lists one "Alice" row reading "3 photos"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-044] A member cancels a merge and keeps both groups
  Given the member pressed "Merge" on a group, and People shows "Pick the group to merge into."
  When the member clicks "cancel" beside that line
  Then the line goes away and every row offers "Merge" again
  And People lists the same groups as before
```

- **Notes:** pressing "Choosing…" on the first group cancels the merge too.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-045] A member splits faces that are not the group's person into a new unnamed group
  Given the member has People open with a group "Alice" reading "3 photos", one of whose faces shows a different person
  When the member presses "Faces" on the "Alice" row, clicks the face that is not Alice, and presses "Split into a new group"
  Then the "Alice" row reads "2 photos"
  And a new row reading "1 photo" and "Add a name" holds the face that was split off
```

- **Notes:** before any face is chosen, the row says "Select the faces that are not this person.", and each chosen face gets an outline while the line reads "1 selected". A group whose every face is split off leaves the list.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-046] A member can pick from every face of a large group when splitting
  Given the member has People open with a group reading "80 photos"
  When the member presses "Faces" on that row
  Then the row shows all 80 faces to choose from
```

- **Notes:** Implementation gap: the row shows only the 60 clearest faces, so a wrong face among the other 20 cannot be split off.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-047] A member who changes the match threshold keeps the existing groups until rebuilding them
  Given the member has scanned the library at the match threshold 0.45 and named the groups "Alice" and "Bob"
  When the member moves the "Match threshold" slider to 0.60 and then opens People
  Then People still lists "Alice" and "Bob" with the same counts as before
```

- **Notes:** the note under the slider reads "Higher is stricter. Changing it only affects faces found from now on — use Rebuild groups in People to re-sort the ones you already have."

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-048] A member rebuilds the groups at the current threshold and sees two mixed people separated
  Given the member scanned at the match threshold 0.20, and People holds one group reading "3 photos" that mixes two people
  And the member has since moved the match threshold to 0.45
  When the member rebuilds the groups from People
  Then People lists the two people in separate groups
```

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-049] A member who rebuilds the groups keeps each name on the new group that holds most of its faces
  Given the member has People open with the groups "Alice" and "Bob"
  When the member presses "Rebuild groups" and confirms
  Then People lists a group named "Alice" holding most of the faces that "Alice" held before
  And People lists a group named "Bob" holding most of the faces that "Bob" held before
```

- **Notes:** Implementation gap: Photos asks "Rebuild every group from scratch? All names will be lost." and, after the member confirms, every group reads "Add a name".

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-051] A member finds a second computer's People holding its own groups, without the first computer's names
  Given the member scanned the library on a laptop and named a group "Alice" there
  And the member's second computer runs Photos with the same library, and the member scanned it there too
  And "Share names and face counts with other apps" is unchecked on the laptop
  When the member opens People on the second computer
  Then People lists that computer's own groups, each reading "Add a name"
```

- **Notes:** each computer finds faces in its own copies and keeps the results on that computer. With sharing off, no face, group, or name leaves the computer. Names the member shares travel as labels on the photos, and People on another computer does not read them.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-052] A member who turns off face detection is asked whether to keep or delete the faces and names found
  Given the member scanned the library and named a group "Alice"
  When the member unchecks "Detect faces in my photos"
  Then Photos asks whether to keep or delete the faces, groups, and names found so far
```

- **Notes:** choosing to delete them leaves People with "No faces grouped yet. Enable face detection and run a scan from the Face recognition panel." Implementation gap: unchecking the box only dims "Scan now". People keeps every group and name, the viewer keeps its "Faces" button, and Photos offers no way to delete the face data.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-053] A member finds the groups and names again after Photos is reinstalled
  Given the member scanned the library on a computer and named a group "Alice"
  And the local operator has since uninstalled Photos, keeping its data, and installed it again
  When the member opens People
  Then People lists "Alice" with the same faces as before
```

- **Notes:** the uninstall and reinstall dialogs belong to APP-LIFE-138 and APP-LIFE-142 in starkeep-core's [app-lifecycle.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/app-lifecycle.md). The face models stay downloaded too.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-054] A local operator who deletes Photos' kept data finds no face groups or names after reinstalling
  Given a member scanned the library on a computer and named a group "Alice"
  And the local operator has since uninstalled Photos and used "Delete data" on its card
  When the local operator installs Photos again and opens People
  Then People says "No faces grouped yet. Enable face detection and run a scan from the Face recognition panel."
```

- **Notes:** Implementation gap: "Delete data" removes Photos' rows and files on the data server but not the face data, which Photos keeps on the computer outside the platform's storage. The reinstalled Photos shows "Alice" again.

## Sharing names with other apps

The "Share names and face counts with other apps" checkbox, off by default, lets other apps find the people in the member's photos. Photos then labels each photo with a face with its face count under `photos/face-count`, and with each named person under `photos/faces`, one label value per name. Photos never shares faces, boxes, or identity vectors. The examples use the library of "beach.jpg", which shows Alice, "party.jpg", which shows Alice and a person the member has not named, and "tree.jpg", which shows no one. Label queries, grants, and deletion belong to starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): reverse queries (SHARED-071, SHARED-072), every reader seeing every app's labels (SHARED-067), labels leaving with a deleted photo (SHARED-107), and labels kept at uninstall (SHARED-083).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-055] A member reads what sharing names and face counts discloses before turning it on
  Given the member has checked "Detect faces in my photos"
  When the member reads the note under "Share names and face counts with other apps"
  Then the note says "Publishes photos/faces and photos/face-count as record labels. Any app that can read your images will then be able to list who is in them. Turning this off retracts what was published."
  And the checkbox is unchecked
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-056] An app developer finds the photos of a person the member named and shared
  Given the member scanned "beach.jpg", "party.jpg", and "tree.jpg", named Alice's group "Alice", and checked "Share names and face counts with other apps"
  And the app developer's app holds a read grant on the member's images
  When the app lists the records labelled "photos/faces" with the value "Alice"
  Then the app receives "beach.jpg" and "party.jpg", and no other record
```

- **Notes:** a name the member types after checking the box reaches the app in the same way, because every rename, merge, split, and rebuild shares the result again.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-057] An app developer finds photos by their face count, and none for photos with no faces
  Given the member scanned "beach.jpg", "party.jpg", and "tree.jpg" and checked "Share names and face counts with other apps"
  And the app developer's app holds a read grant on the member's images
  When the app lists the records that carry the label "photos/face-count", with their labels
  Then the app receives "beach.jpg" with the value "1" and "party.jpg" with the value "2"
  And the app does not receive "tree.jpg"
```

- **Notes:** a photo with no faces carries neither label, so a query for "photos/face-count" means "has at least one face".

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-058] An app developer finds a face count but no name on a photo whose people are unnamed
  Given the member scanned "dog.jpg", which shows one person whose group the member has not named
  And the member checked "Share names and face counts with other apps"
  And the app developer's app holds a read grant on the member's images
  When the app reads "dog.jpg" with its labels
  Then the app receives the label "photos/face-count" with the value "1"
  And the app receives no "photos/faces" label on "dog.jpg"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-059] An app developer finds the photos under a person's new name, and none under the old one
  Given the member scanned "beach.jpg" and "party.jpg", named Alice's group "Alice", and shares names and face counts
  And the member has since renamed the group "Alicia" in People
  And the app developer's app holds a read grant on the member's images
  When the app lists the records labelled "photos/faces", with their labels
  Then the app receives "beach.jpg" and "party.jpg", each with the value "Alicia"
  And no record carries the value "Alice"
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-060] An app developer finds no face labels once the member stops sharing
  Given the member shared names and face counts for "beach.jpg" and "party.jpg"
  And the member has since unchecked "Share names and face counts with other apps" while face detection stayed on
  And the app developer's app holds a read grant on the member's images
  When the app lists the records labelled "photos/faces", and then those labelled "photos/face-count"
  Then the app receives no records for either label
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-061] An app developer finds the face labels of a photo scanned after sharing began
  Given the member scanned "beach.jpg" and "party.jpg", named Alice's group "Alice", and shares names and face counts
  And the member has since added "picnic.jpg", which shows Alice, and scanned the library
  And the app developer's app holds a read grant on the member's images
  When the app lists the records labelled "photos/faces" with the value "Alice"
  Then the app receives "beach.jpg", "party.jpg", and "picnic.jpg"
```

- **Notes:** Implementation gap: a scan shares nothing, so "picnic.jpg" carries no face label until the member next changes a group in People or checks the box again.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-PEOPLE-062] An app developer finds at most 32 names on one group photo
  Given the member scanned "team.jpg", which shows 40 people, and named all 40 groups
  And the member shares names and face counts
  And the app developer's app holds a read grant on the member's images
  When the app reads "team.jpg" with its labels
  Then the app receives the 32 names that sort first under "photos/faces"
  And the app receives the label "photos/face-count" with the value "40"
```

- **Notes:** the platform allows 32 values of one key on one record (SHARED-059 in [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). Photos shares the same 32 names every time, so the set stays stable.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-063] A member who gives a group a name too long to share is told so
  Given the member shares names and face counts
  When the member names a group with a name longer than 128 bytes, such as 50 Chinese characters, and presses Enter
  Then People says in plain words that the name is too long to share with other apps
  And the name still shows in People and in the viewer
```

- **Notes:** Implementation gap: Photos saves the name, shows it in Photos, and leaves it out of the shared labels without a word.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-064] A member who turns off face detection while sharing can still stop sharing
  Given the member shares names and face counts
  And the member has since unchecked "Detect faces in my photos" and kept the faces found
  When the member unchecks "Share names and face counts with other apps"
  Then the checkbox reads unchecked
  And the panel shows no error
```

- **Notes:** Implementation gap: with face detection off, the sharing checkbox stays checked and dimmed and cannot be changed, so the names stay shared until the member turns face detection on again.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-PEOPLE-065] An app developer finds the face labels of a member who turned on sharing while the computer's data server was not answering
  Given the member scanned "beach.jpg" and "party.jpg" and named Alice's group "Alice"
  And the member checked "Share names and face counts with other apps" while the computer's data server did not answer for a moment
  And the data server has answered again since
  And the app developer's app holds a read grant on the member's images
  When the app lists the records labelled "photos/faces" with the value "Alice"
  Then the app receives "beach.jpg" and "party.jpg"
```

- **Notes:** Implementation gap: Photos tries once. The member's panel shows the raw error, such as "label publish failed: <status> <body>", the checkbox stays checked, and nothing is shared until the member's next change in People or a second toggle. A failed share after a rename, merge, or split shows the same raw text in People's error box and keeps the change.
