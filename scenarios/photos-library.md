# Photos: the library grid and the viewer

This file specifies how a member browses photos in Photos on the web: opening Photos, the library grid and its order, layout, and date headings, keeping the grid current, selecting photos, the single-photo viewer and its controls, captions, deleting a photo, the Settings menu, and the cover image. The member uses Photos on a computer, where Photos runs beside the member's own data server, and cloud-served Photos in a browser. Every scenario has the member as its actor.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-import-and-processing.md](photos-import-and-processing.md): adding photos, the details read from each file, the info panel's rows, grid tiles and their previews, and video playback
- [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md): albums, the selection bar's actions, public links, and cloud-served Photos
- [photos-mobile.md](photos-mobile.md): the phone's library, viewer, info sheet, and captions
- [photos-people.md](photos-people.md): face recognition, the viewer's Faces toggle, and its scan
- starkeep-core [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md): signing in to cloud apps, sessions, and the local Host and origin guard
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): capture-time order, deletion, the trash window, and restore
- starkeep-core [drive.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/drive.md): Drive's Trash
- starkeep-core [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md): photos and app rows reaching the member's other devices
- starkeep-core [cloud-runtime.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/cloud-runtime.md): a busy deployment

## Opening Photos

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-001] A member opens Photos on a computer and sees the library without signing in
  Given the member installed Photos on a computer that has never signed in to a cloud
  And the member's library on the computer holds photos
  When the member opens Photos in a browser on the computer
  Then Photos shows the member's photos in the grid
  And Photos asks for no sign-in, and its Settings menu offers no "Sign out"
```

- **Notes:** signing the computer in to a cloud buys sync only. The local Host and origin guard is ACCESS-168 to ACCESS-172 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-002] A member who follows a link to a photo while signed out sees that photo after signing in
  Given the member holds no session for cloud Photos
  And the member saved the address of one of the member's photos while signed in earlier
  When the member opens the saved address, chooses "Sign in" on "Sign in to Photos", and signs in on the managed login page
  Then cloud Photos opens with that photo in the viewer
```

- **Notes:** Implementation gap: Photos' sign-in page always returns to the library, so the member lands on the grid and must find the photo again. The general rule is ACCESS-034.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-003] A member signs out of cloud Photos from the Settings menu and sees Photos' sign-in page
  Given the member is signed in to cloud Photos
  When the member opens the Settings menu and chooses "Sign out" under "Account"
  Then the browser shows "Sign in to Photos" with its "Sign in" button
  And choosing "Sign in" asks for the member's password again on the managed login page
```

- **Notes:** the session rules are ACCESS-042 to ACCESS-046 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md).

## The library grid

### Order and layout

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-004] A member sees photos and videos in one grid, the most recently taken first
  Given the member's library holds a photo taken on 2 June 2026, a video recorded on 9 June 2026, and a photo taken on 30 May 2026
  When the member opens the Photos tab
  Then the grid shows the video first, then the 2 June photo, then the 30 May photo
```

- **Notes:** the order is the date taken, which Photos reads from each file (PHOTOS-IMPORT-013, PHOTOS-IMPORT-019). Two photos taken at the same moment keep one fixed order between loads. The platform's capture-time order is SHARED-035 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md).

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-005] A member sees photos with no date taken after every dated photo, the most recently added first
  Given the member's library holds photos taken in 2019 and in 2026
  And the member added two screenshots with no date taken, one last week and one today
  When the member opens the Photos tab
  Then the grid shows every dated photo first, newest taken first
  And the two screenshots follow the 2019 photos, today's screenshot before last week's
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-006] A member sees every full row of the grid fill the window's width, each photo at its own shape
  Given the member's library holds portrait, landscape, and panorama photos
  When the member opens the Photos tab
  Then each full row of photos reaches from one side of the grid to the other, with a small even gap between photos
  And each photo shows at its own shape, a portrait photo narrower than a landscape photo in the same row
  And no photo loses more than a tenth of its width to a trim at its sides
```

- **Notes:** the last row keeps the chosen height and stops short of the right edge rather than stretching. A photo whose details Photos has not read yet takes a slightly wide shape until they arrive. A photo stored sideways takes its upright shape (PHOTOS-IMPORT-018). The phone's grid uses square tiles instead (PHOTOS-MOB-011, PHOTOS-MOB-012).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-007] A member changes the row height in Settings and sees the rows resize
  Given the member has the Photos tab open with rows about 320 pixels tall
  When the member opens the Settings menu and drags "Row height" to 200
  Then the menu shows "200px" beside the slider
  And the grid's rows redraw at about 200 pixels tall, with more photos in each row
```

- **Notes:** the slider runs from 100 to 480 in steps of 10. A row is scaled to fill the width, so its height lands near the chosen value rather than on it.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-008] A member finds the row height and date headings as chosen the next time Photos opens in that browser
  Given the member set "Row height" to 240 and turned on "Date headings" in Settings
  When the member closes the tab and opens Photos again in the same browser
  Then the grid shows rows about 240 pixels tall, under date headings
  And Photos in another browser, or on another device, keeps its own choices
```

- **Notes:** a browser that refuses to store site data keeps the choice until the tab closes.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-009] A member who never chose a row height sees taller rows in a wide window than in a phone-width one
  Given the member has never moved "Row height" in this browser
  When the member opens Photos in a window 768 pixels wide or wider, and then in a window narrower than 768 pixels
  Then the wide window shows rows about 320 pixels tall
  And the narrow window shows rows about 180 pixels tall
```

- **Notes:** once the member moves the slider, the chosen height applies at every width.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-010] A member in a phone-width window sees the photos run to the window's edges
  Given the member opens Photos in a window narrower than 768 pixels
  When the member looks at the grid
  Then the photos reach the left and right edges of the window with no margin
  And a wider window shows a margin of 16 pixels on each side
```

### Date headings

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-011] A member sees no date headings until turning on "Date headings" in Settings
  Given the member has never changed "Date headings" in this browser
  When the member opens the Photos tab
  Then the grid shows one run of photos with no headings
  And turning on "Date headings" in Settings puts a heading such as "November 23, 2026" above each day's photos
```

- **Notes:** the heading follows the browser's language, such as "23 November 2026" in British English.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-012] A member sees an evening photo under the heading of the day it was taken, not the next day
  Given the member lives in New York and the browser runs on New York time
  And the member took a photo at 21:30 on 23 November 2026 in New York, and the photo's file records that time and its offset
  And "Date headings" is on
  When the member opens the Photos tab
  Then the photo sits under "November 23, 2026"
```

- **Notes:** Implementation gap: the headings split days at midnight UTC, so the photo sits under "November 24, 2026". Every photo taken in New York after 19:00 in winter lands on the next day.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-013] A member who views the library in another time zone sees a photo under the day it was taken where it was taken
  Given the member took a photo at 08:00 on 4 March 2026 in Tokyo, and the photo's file records that time and its offset
  And the member now opens Photos in a browser that runs on New York time, where that moment was 18:00 on 3 March
  And "Date headings" is on
  When the member opens the Photos tab
  Then the photo sits under "March 4, 2026"
```

- **Notes:** Implementation gap: the headings split days at midnight UTC, so the photo sits under "March 3, 2026". The info panel's own date taken is PHOTOS-IMPORT-016.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-014] A member sees photos with no date taken under a heading of their own at the end of the library
  Given the member's library holds photos taken on 24 November 2026
  And the member added a screenshot with no date taken on 24 November 2026
  And "Date headings" is on
  When the member scrolls to the end of the library
  Then the screenshot sits under a heading that says its date taken is unknown
  And "November 24, 2026" appears once, at the top, above only the photos taken that day
```

- **Notes:** Implementation gap: the screenshot sits under a second "November 24, 2026" heading at the end of the library, the day it was added in UTC.

### Loading and empty states

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-015] A member sees "Loading..." until the library first loads
  Given the member's library holds photos
  When the member opens Photos
  Then the page shows "Loading..." where the grid goes until the library arrives
  And the grid then replaces "Loading..."
```

- **Notes:** a first load that failed keeps "Loading..." rather than claiming an empty library. Cloud Photos first shows "Loading…" while it checks the member's sign-in.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-016] A member with an empty library reads "No photos yet. Upload some to get started."
  Given the member's library holds no photos or videos
  When the member opens the Photos tab
  Then the page shows "No photos yet. Upload some to get started."
```

- **Notes:** on a computer, the header's add button reads "Add Photo", and photos also arrive from watched folders. In cloud Photos the button reads "Upload Photo".

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-017] A member opens cloud Photos while the deployment is busy and sees the library with no error
  Given the member's deployment is busy enough that it turns some requests away for a moment
  When the member opens cloud Photos
  Then the grid shows the member's photos, perhaps a moment later than usual
  And the page shows no error
```

- **Notes:** Implementation gap: Photos retries a turned-away request for file links, but not for the library list, a delete, or a caption, so a busy moment shows a red error with a status code. The rule for the example app is CLOUD-RUN-020 in starkeep-core's [cloud-runtime.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/cloud-runtime.md).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-018] A member whose library failed to load once sees the error go away once the library loads
  Given the member's Photos page showed an error after a brief network failure
  And the network works again
  When the member keeps the page open while a new photo reaches the library
  Then the grid shows the new photo
  And the error no longer shows
```

- **Notes:** Implementation gap: the error stays on the page until the member adds a photo or reloads. In cloud Photos the next update comes within a minute. On a computer it comes with the next change to the library.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-LIB-019] A member whose library cannot load reads what went wrong in plain words
  Given the data server on the member's computer has stopped while Photos stayed open
  When the member reloads the Photos page
  Then the page says in plain words that Photos cannot reach the member's library right now
  And the page shows no request path or status code
```

- **Notes:** Implementation gap: the error repeats the failed request, in the form "<request path> failed: <status> <response body>".

### Keeping the grid current

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-020] A member sees a photo that reached the computer appear in Photos without reloading
  Given the member has Photos open on a computer
  When the member copies a photo into a watched folder
  Then the photo appears in the grid at its place in the order, without a reload
```

- **Notes:** a photo from the member's phone or another computer appears the same way once it syncs to this computer (SYNC-004 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md)). Photos learns of each change from the data server's events stream ([local-data-server.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/local-data-server.md)).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-021] A member sees a new photo appear in cloud Photos within a minute without reloading
  Given the member has cloud Photos open in a browser
  And the member's phone has just finished uploading a new photo to the cloud
  When the member keeps cloud Photos open and visible
  Then the photo appears in the grid within a minute of the upload finishing, without a reload
```

- **Notes:** cloud Photos asks for changes every 30 seconds while the tab is visible.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-022] A member sees a photo deleted on another device leave the grid without reloading
  Given the member has Photos open
  When the member deletes one of the photos on the phone
  Then the photo leaves the grid once the deletion syncs, without a reload
```

- **Notes:** in cloud Photos the photo leaves within a minute of the deletion reaching the cloud.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-023] A member who returns to a Photos tab that was hidden for a minute sees the changes at once
  Given the member switched away from the Photos tab for a minute
  And a new photo reached the member's library meanwhile
  When the member switches back to the Photos tab
  Then the new photo appears in the grid at once, without waiting for the next update
```

- **Notes:** a hidden tab stops asking for changes. A tab hidden for 30 seconds or less does not check for changes at once when it shows again.

### The header in a phone-width window

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-024] A member in a phone-width window sees the header slide away while scrolling down and come back while scrolling up
  Given the member opens Photos in a window narrower than 768 pixels
  When the member scrolls down past the top of the library, and then scrolls up a little
  Then the header with the tabs, the add button, and the gear slides out of view while the member scrolls down
  And the header slides back while the member scrolls up
```

- **Notes:** the header stays in place within the top 64 pixels of the page and in a wider window. With reduced motion asked for in the system settings, the header hides and returns without sliding.

## Selecting photos

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-026] A member selects a photo with its checkbox and sees "1 selected"
  Given the member has the Photos tab open in a browser with a mouse
  When the member points at a photo and clicks the round checkbox in its upper left corner
  Then the photo shows a selected ring and a checked checkbox
  And a bar at the foot of the screen reads "1 selected" with "Clear" among its buttons
  And every photo in the grid now shows its checkbox
```

- **Notes:** the checkbox shows only while the pointer rests on a photo, until a selection starts. Clicking the checkbox never opens the photo. The bar's other buttons are in [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md). Opening an album or going back to the library starts with no selection.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-027] A member who is selecting toggles a photo with a click instead of opening it
  Given the member has selected one photo
  When the member clicks another photo
  Then the second photo becomes selected and the bar reads "2 selected"
  And the viewer does not open
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-028] A member shift-clicks a photo to select every photo between it and the last one chosen
  Given the member selected the third photo in the grid
  When the member holds Shift and clicks the eighth photo
  Then the third to eighth photos are all selected, and the bar reads "6 selected"
```

- **Notes:** the run follows the grid's order and keeps photos selected earlier. The run grows from the photo last chosen.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-029] A member on a touch screen starts a selection with a long press, and the photo does not open
  Given the member has Photos open on a touch screen
  When the member rests a finger on a photo for half a second and lifts it
  Then the photo becomes selected and the bar reads "1 selected"
  And the viewer does not open
```

- **Notes:** a finger that moves more than about 10 pixels scrolls instead, and a shorter tap opens the photo.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [PHOTOS-LIB-030] A member ends a selection with Clear, with Escape, or by unselecting the last photo
  Given the member has selected one photo
  When the member <ends>
  Then no photo shows as selected and the selection bar is gone
  And a click on a photo opens it in the viewer again

  Examples:
    | ends                                       |
    | chooses "Clear" in the selection bar       |
    | presses Escape                             |
    | clicks the selected photo's checkbox again |
```

- **Notes:** Escape leaves the selection alone while the bar's album picker is open.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-031] A member sees a photo that leaves the grid leave the selection too
  Given the member has selected three photos
  When the member deletes one of the three on the phone
  Then once the deletion syncs, the photo leaves the grid and the bar reads "2 selected"
```

## The viewer

### Opening and closing

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-032] A member opens a photo from the grid and sees it in the viewer with its file name
  Given the member's library holds the photo "IMG_2041.jpg"
  When the member clicks the photo in the grid
  Then the viewer fills the window on a black background and shows the photo whole
  And the viewer's top line shows "IMG_2041.jpg", the "Info", "Share link…", and "Delete" buttons, and a close button
```

- **Notes:** a video opens in the same viewer with its player (PHOTOS-IMPORT-038, PHOTOS-IMPORT-039). A "Faces" button joins the line when Photos found faces in the photo ([photos-people.md](photos-people.md)). "Share link…" is in [photos-sharing-and-cloud.md](photos-sharing-and-cloud.md). A caption shows under the photo (PHOTOS-LIB-056).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [PHOTOS-LIB-033] A member closes the viewer with the close button or Escape
  Given the member opened a photo from the grid
  When the member <closes>
  Then the viewer closes and the grid shows where the member left it

  Examples:
    | closes                          |
    | clicks the viewer's close button |
    | presses Escape                  |
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-034] A member who presses Back closes the viewer and stays in Photos
  Given the member opened a photo from the grid
  When the member presses the browser's Back button
  Then the viewer closes and the grid shows
  And pressing Forward opens the same photo again
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-035] A member who reloads the page with a photo open sees the same photo open
  Given the member has the photo "IMG_2041.jpg" open in the viewer
  When the member reloads the page
  Then Photos opens with "IMG_2041.jpg" in the viewer once the library loads
```

- **Notes:** the address of an open photo ends in "/photo/" and the photo's id, under "/apps/photos" in the cloud.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-036] A member who opens a link to a photo sees it over the library, and closing it shows the grid
  Given the member saved the address of the photo "IMG_2041.jpg" while it was open
  When the member opens the saved address in a new tab and closes the viewer
  Then the tab first shows "IMG_2041.jpg" in the viewer
  And closing the viewer shows the library grid in the same tab, not the page the member came from
```

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-037] A member who opens a link to a photo the library does not hold sees the grid
  Given the member saved the address of a photo and deleted the photo afterwards
  When the member opens the saved address
  Then Photos shows the library grid once the library loads, with no viewer open
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-038] A member whose open photo was deleted on another device sees the viewer close
  Given the member has a photo open in the viewer
  When the member deletes the same photo on the phone
  Then once the deletion syncs, the viewer closes and the grid shows without the photo
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-039] A member in a phone-width window keeps the close button on the viewer's first line
  Given the member opens a photo with a long file name in a window narrower than 768 pixels
  When the viewer opens
  Then the first line shows the file name, cut short if it does not fit, and the close button
  And the "Info", "Share link…", and "Delete" buttons sit on a second line
  And the photo fills the window's full width
```

### Stepping through photos

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-040] A member steps to the next and the previous photo with the arrow keys, in the grid's order
  Given the member opened the third photo in the grid
  When the member presses the right arrow key, and then the left arrow key twice
  Then the viewer shows the fourth photo, then the third, then the second
```

- **Notes:** an arrow key pressed with Shift, Control, Alt, or Command is left to the browser. A key on a focused video player belongs to the player.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-041] A member at the last photo stays on it when pressing the right arrow
  Given the member opened the last photo in the grid
  When the member presses the right arrow key
  Then the viewer keeps showing the last photo
```

- **Notes:** the left arrow on the first photo does the same.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-042] A member who opened a photo in an album steps through only that album's photos
  Given the member opened the album "Lisbon", which holds three of the member's photos
  And the member opened the album's first photo
  When the member presses the right arrow key three times
  Then the viewer shows the album's second photo, then its third, and then stays on the third
```

- **Notes:** a photo outside the open album, such as one reopened with the browser's Forward button, steps through the whole library.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-043] A member typing a caption moves the cursor with the arrow keys and stays on the photo
  Given the member has the info panel open and is typing in the caption box
  When the member presses the left arrow key
  Then the cursor moves one character left in the caption
  And the viewer keeps showing the same photo
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-044] A member who stepped through several photos closes the viewer with one Back
  Given the member opened a photo from the grid and stepped through four more with the arrow keys
  When the member presses the browser's Back button once
  Then the viewer closes and the grid shows
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-045] A member who steps to another photo never sees the previous photo in its place
  Given the member opened a photo from the grid
  And the next photo shows in the grid, but its sharper picture has not loaded in this browser
  When the member presses the right arrow key
  Then the viewer shows the next photo's grid picture at once
  And the previous photo never shows in its place while the sharper picture loads
```

### How the photo draws

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-046] A member sees the grid's picture at once on opening a photo, and then the sharper size in its place
  Given the member's photo shows in the grid from its 640-pixel preview
  And the member's window and screen call for the photo's 2,560-pixel preview, which the browser has not loaded yet
  When the member opens the photo
  Then the viewer shows the grid's picture at once, at the viewer's size
  And the 2,560-pixel preview replaces it in place once loaded, with no blank or flash in between
```

- **Notes:** the viewer never swaps to a picture smaller than the one it opened with.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-047] A member sees a pulsing box of the photo's shape until a first picture draws
  Given the member's portrait photo has not shown in the grid in this browser
  When the member opens the photo from a saved address
  Then the viewer shows a softly pulsing grey box of the photo's portrait shape
  And the photo appears in the box once its picture loads, with no blurred version in between
```

- **Notes:** a photo whose shape Photos has not read yet gets a box the height of the window.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-048] A member sees the photo sharp for the viewer's size on a high-density screen
  Given the member's 6000 × 4000 photo has every preview size
  And the member views Photos in a window 1400 by 900 pixels on a screen with two device pixels to each CSS pixel
  When the member opens the photo
  Then the viewer shows the photo from its 2,560-pixel preview
  And a screen with one device pixel to each CSS pixel shows the 1,280-pixel preview in the same window
```

- **Notes:** the photo fills a box 1,170 pixels wide, which needs 2,340 device pixels, and Photos rounds up to the next size it makes. A photo smaller than its box shows at its own size. The viewer reads a preview, never a large original.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-049] A member who enlarges the window sees the photo sharpen to the larger size
  Given the member's 6000 × 4000 photo has every preview size
  And the member opened it in a window 1000 by 700 pixels on a standard screen, where it shows from the 1,280-pixel preview
  When the member enlarges the window to 2000 by 1300 pixels
  Then the photo sharpens in place to the 2,560-pixel preview, with no blank in between
```

- **Notes:** a resize within the same preview size asks for nothing new.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-050] A member whose photo failed to load in the viewer sees the box stay, never a broken image, and the photo on a later try
  Given the member opens a photo that has not shown in this browser
  And the photo's picture fails to load because of a brief network error
  When the member keeps the viewer open
  Then the viewer keeps the pulsing box and shows no broken-image icon
  And the photo appears after a later try, within 90 seconds of the network working again
```

- **Notes:** when a picture already shows and only the sharper size fails, the viewer keeps the picture it has. The tries follow the grid's timing (PHOTOS-IMPORT-030).

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-LIB-052] A member who opens a newly added large photo on the computer sees it sharp within seconds
  Given the member just copied 2,000 large photos into a watched folder
  And Photos on the computer has made the smallest previews for them, but not the larger ones yet
  When the member opens one of the new photos in the viewer
  Then the viewer shows the photo sharp at the viewer's size within a few seconds
```

- **Notes:** Implementation gap: the viewer shows the small grid picture, scaled up and blurry, until Photos' background pass reaches the larger sizes for that photo, which can take as long as the whole import. Cloud Photos makes a missing size on demand (PHOTOS-IMPORT-031).

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-053] A member who opens a photo that cannot be displayed reads why in the viewer
  Given the member's grid shows "Cannot be displayed" on a photo that Photos cannot read here, such as a HEIC photo on a computer that is not a Mac
  When the member opens the photo
  Then the viewer shows "Cannot be displayed" and the same explanation the grid offers
```

- **Notes:** Implementation gap: the viewer shows its pulsing box for as long as it stays open. The grid's message and explanation are PHOTOS-IMPORT-035 and PHOTOS-IMPORT-036.

### The info panel

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-054] A member opens the info panel with Info or by clicking the photo
  Given the member has a photo open in the viewer
  When the member chooses "Info", or clicks the photo itself
  Then a "Photo Info" panel slides in from the right over the photo
  And the panel lists the photo's details and a caption box
```

- **Notes:** the panel's rows, their order, and their format are PHOTOS-IMPORT-021 to PHOTOS-IMPORT-023. A photo whose details nobody has read gets them when the panel opens (PHOTOS-IMPORT-012). The panel stays open while the member steps to another photo, and shows that photo's details.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-055] A member closes the info panel with its close button, with Info, or by clicking the photo
  Given the member has the info panel open
  When the member clicks the panel's close button, or chooses "Info" again, or clicks the photo again
  Then the panel slides away and the photo shows without it
```

## Captions

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-056] A member adds a caption in the info panel and sees it under the photo
  Given the member has the info panel open on a photo with no caption
  When the member types "Grandma's 90th" in the box that reads "Add a caption…" and clicks outside the box
  Then "Grandma's 90th" shows under the photo in the viewer
  And the caption box keeps "Grandma's 90th" when the member opens the panel on that photo again
```

- **Notes:** the caption saves when the box loses focus. The box reads "Loading…" and takes no typing until the photo's details arrive.

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-057] A member finds a caption still there after Photos restarts
  Given the member gave a photo the caption "Grandma's 90th" in Photos on the computer
  And Photos has since stopped and started again on the computer
  When the member opens the photo again
  Then "Grandma's 90th" shows under the photo and in the caption box
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-058] A member clears a caption and sees it leave the photo
  Given the member's photo has the caption "Grandma's 90th"
  When the member deletes the caption's text in the info panel and clicks outside the box
  Then no caption shows under the photo
  And the caption box reads "Add a caption…" when the member opens the panel on that photo again
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-059] A member sees a caption written on the computer in cloud Photos too
  Given the member's computer is signed in to the member's cloud
  And the member gave a photo the caption "Grandma's 90th" in Photos on the computer
  When the member opens the same photo in cloud Photos after the next sync
  Then "Grandma's 90th" shows under the photo and in the caption box
```

- **Notes:** a caption written in cloud Photos reaches the computer the same way. Captions sync as the app's own rows (SYNC-015 in starkeep-core's [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md)). The phone's captions are in [photos-mobile.md](photos-mobile.md).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-060] A member finds no Photos caption in Drive
  Given the member gave a photo the caption "Grandma's 90th" in Photos
  When the member finds the same photo in Drive
  Then Drive lists the photo
  And "Grandma's 90th" appears nowhere in Drive
```

- **Notes:** a caption belongs to Photos alone. Another app sees the photo, never its caption.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-061] A member who types a caption longer than 2,000 characters learns that it was not saved
  Given the member has the info panel open on a photo
  When the member pastes 2,500 characters into the caption box and clicks outside the box
  Then the panel says that a caption holds at most 2,000 characters and that this one was not saved
  And the member's text stays in the box to shorten
```

- **Notes:** Implementation gap: the text shows under the photo as if saved, and is gone the next time the member opens the panel. The phone keeps the same 2,000-character limit.

## Deleting a photo

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-062] A member deletes a photo from the viewer after confirming, and the photo leaves the grid
  Given the member uses Photos and Drive on the computer
  And the member has the photo "IMG_2041.jpg" open in Photos' viewer
  When the member chooses "Delete"
  Then the browser asks "Delete IMG_2041.jpg?" and explains "It moves to Drive's Trash, where you can restore it for as long as your library keeps deleted items."
  And after the member confirms, the viewer closes and the photo is gone from the grid
  And the photo shows in Drive's Trash
```

- **Notes:** the photo's previews and its labels go with it, and the deletion reaches the member's other devices (SHARED-107 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). Drive's Trash is DRIVE-038 in starkeep-core's [drive.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/drive.md). How long the Trash keeps a photo is SHARED-200.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-063] A member who declines the confirmation keeps the photo
  Given the member chose "Delete" on the photo "IMG_2041.jpg" in the viewer
  When the member cancels the browser's "Delete IMG_2041.jpg?" question
  Then the viewer keeps showing the photo
  And the photo stays in the grid
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-064] A member sees "Deleting…" while the delete runs
  Given the member has a photo open in the viewer, and the library answers slowly
  When the member chooses "Delete" and confirms
  Then the button reads "Deleting…" and does not respond to another click until the delete finishes
```

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-LIB-065] A member who deletes a photo in cloud Photos learns where to restore it
  Given the member uses cloud Photos and the phone, and runs Drive on no computer
  When the member chooses "Delete" on a photo in cloud Photos
  Then the question names a place where this member can restore the photo
```

- **Notes:** the question says "It moves to Drive's Trash, where you can restore it for as long as your library keeps deleted items." Drive's Trash runs only in Drive on a computer.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-LIB-066] A member whose delete fails stays in the viewer and reads why in plain words
  Given the data server on the member's computer has stopped while a photo stayed open in Photos
  When the member chooses "Delete" and confirms
  Then the viewer stays open on the photo
  And a message under the viewer's top line says in plain words that Photos could not delete the photo, and why
  And the photo stays in the grid
```

- **Notes:** Implementation gap: the message repeats the failed request, in the form "<request path> failed: <status> <response body>".

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-067] A member who restores a deleted photo in Drive sees it back in Photos without reloading
  Given the member deleted a photo in Photos on the computer and keeps Photos open
  When the member restores the photo from Drive's Trash on the same computer
  Then the photo appears in Photos' grid again at its place in the order, without a reload
```

- **Notes:** the restore itself is DRIVE-043 in starkeep-core's [drive.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/drive.md) and SHARED-116 in [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md).

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-LIB-068] A member who restores a deleted photo finds its caption again
  Given the member's photo has the caption "Grandma's 90th"
  And the member deleted the photo in Photos and restored it from Drive's Trash
  When the member opens the photo in Photos
  Then "Grandma's 90th" shows under the photo
```

- **Notes:** Implementation gap: Photos deletes the caption with the photo, so the restored photo comes back without it. The platform keeps an app's own rows across a delete and a restore (SHARED-123).

## Settings

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-069] A member opens Settings from the gear and closes it with Escape or a click elsewhere
  Given the member has Photos open
  When the member clicks the gear button at the right of the header
  Then a "Settings" menu opens with "Display", "Cover image", and "Archive quality" sections
  And pressing Escape, or clicking anywhere outside the menu, closes it
```

- **Notes:** on a computer the menu adds "On-device face recognition" under "Library" ([photos-people.md](photos-people.md)). In cloud Photos it adds "Sign out" under "Account" (PHOTOS-LIB-003).

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-LIB-070] A member on a computer reads in Settings where the archive quality is set, with a link to it
  Given the member has Photos open on a computer
  When the member opens the Settings menu
  Then "Archive quality" reads "The quality kept when originals archive covers your whole Starkeep library, so Admin owns the setting. Change the setting in Admin → Data Server card menu → Storage."
  And "Open Admin's Storage page ↗" opens admin-web's Storage page in a new tab
```

- **Notes:** the link goes to admin-web's default address on this computer. The setting itself is in starkeep-core's [residency-and-stand-ins.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/residency-and-stand-ins.md).

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-LIB-071] A member in cloud Photos reads in Settings where the archive quality is set
  Given the member has cloud Photos open
  When the member opens the Settings menu
  Then "Archive quality" reads "The quality kept when originals archive covers your whole Starkeep library, so Admin owns the setting. Change the setting in Admin → Data Server card menu → Storage."
  And the section offers no link
```

## The cover image

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-072] A member sets a cover image in Settings and sees it above the library
  Given the member's Photos shows no cover image
  When the member opens the Settings menu, chooses "Set cover" under "Cover image", and picks a 2 MB picture
  Then the button reads "Saving…" while the picture uploads
  And the picture shows as a wide banner above the library grid, and the button reads "Change cover"
```

- **Notes:** the banner shows on the Photos tab only, not on the Albums tab. Photos without a cover shows no banner and no empty space for one.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-LIB-073] A member removes the cover and sees the library with no banner
  Given the member's Photos shows a cover image
  When the member chooses "Remove" under "Cover image" in Settings
  Then the banner leaves the top of the library
  And the button reads "Set cover" again
```

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-LIB-075] A member who picks a cover larger than 20 MB reads "Cover image too large (20 MB limit)"
  Given the member has Photos open on a computer
  When the member chooses "Set cover" and picks a 25 MB picture
  Then the "Cover image" section shows "Cover image too large (20 MB limit)"
  And the cover stays as it was
```

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-LIB-076] A member sets a 10 MB cover in cloud Photos and sees it above the library
  Given the member has cloud Photos open
  When the member chooses "Set cover" and picks a 10 MB picture
  Then the picture shows as the banner above the library grid
```

- **Notes:** Implementation gap: the picture travels to the cloud in one request, and the cloud refuses a request that large before Photos' own 20 MB check runs, so the section shows an upload failure with a status code. The cloud's one-request limit is BYTES-038 in starkeep-core's [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md).
