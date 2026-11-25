# Photos: albums, public links, and cloud-served Photos

This file specifies how a member groups photos into albums, how a member shares an album or one photo through a public link, what a visitor sees on a link's page, and what Photos adds when it runs in the cloud at its address under `/apps/photos`. The member uses Photos on a computer and cloud Photos in a browser. The visitor has no account and opens a link the member sent. The local operator reads Photos' log on a computer. Albums live with the member's library, so Photos on a computer makes and changes them offline and syncs them later. Public links live in the cloud alone, so making or changing a link needs the cloud.

The scenario conventions live in starkeep-core's [scenarios/README.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/README.md).

Related files:

- [photos-library.md](photos-library.md): the library grid, selecting photos, the viewer, sign-in, and the settings menu
- [photos-import-and-processing.md](photos-import-and-processing.md): adding photos, previews, and the states of a grid tile
- [photos-people.md](photos-people.md): face recognition, which runs on a computer only
- [photos-mobile.md](photos-mobile.md): Photos on the phone, which has no albums yet
- starkeep-core [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md): labels, and the platform's rules for public links
- starkeep-core [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md): sign-in to cloud apps, and sharing an album with another member (ACCESS-114)
- starkeep-core [cloud-runtime.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/cloud-runtime.md): hosting an app under `/apps/<appId>`, and serving its files
- starkeep-core [sync.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/sync.md): how albums and their photos reach the member's other devices
- starkeep-core [uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md): upload order, and files still awaiting upload

## Albums

Photos shows two tabs in its header, "Photos" for the library and "Albums" for the member's albums. An album holds photos the member chose, and a photo can belong to several albums. Deleting an album never deletes a photo. Albums work the same way on a computer and in cloud Photos. Photos on the phone shows no albums yet.

### Making and naming albums

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-001] A member makes an album from the Albums tab and lands in it, empty
  Given the member has Photos open on the Albums tab
  When the member presses "New album", types "Summer 2026", and presses "Create"
  Then Photos opens the album, whose heading reads "Summer 2026" and "0 photos"
  And the Albums tab, behind the album's "← Albums" button, lists "Summer 2026" first
```

- **Notes:** Photos trims spaces around a name. The form's "Cancel" button closes the form without making an album.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-002] A member with no albums is told how to make one
  Given the member has made no albums
  When the member opens the Albums tab
  Then the tab says "No albums yet. Select photos in the library and choose "Add to album…", or make one here."
  And the tab shows the "New album" button
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-003] A member sees every album with its cover, title, and photo count, newest album first
  Given the member made the album "Beach" last week with three photos
  And the member made the album "Garden" today with one photo
  When the member opens the Albums tab
  Then "Garden" appears before "Beach"
  And each album shows its cover photo and its title
  And "Garden" reads "1 photo" and "Beach" reads "3 photos"
```

- **Notes:** the order follows when the member made each album, not when the member last changed it. Pressing an album's card opens the album.

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [PHOTOS-SHARE-004] A member cannot save a blank album name
  Given the member has <form> open
  When the member clears the name field or types only spaces
  Then the "<button>" button stays disabled

  Examples:
    | form                                               | button         |
    | the Albums tab's "New album" form                  | Create         |
    | an album's "Rename" form                           | Save           |
    | the "New album" field in the "Add to album…" dialog | Create and add |
```

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-005] A member who pastes an album name longer than 200 characters gets it cut to 200 and can save it
  Given the member has the Albums tab's "New album" form open
  When the member pastes a name of 201 characters into the name field
  Then the field keeps only the first 200 characters
  And the "Create" button saves the album under those 200 characters
```

- **Notes:** Implementation gap: the Albums tab's "New album" form and an album's "Rename" form take a name of any length, and leave "Create" or "Save" disabled with no explanation once the name passes 200 characters. The "Add to album…" dialog and the link dialog stop the field at 200 characters.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-006] A member renames an album and sees the new name in the album and on the Albums tab
  Given the member has the album "Beach"
  When the member opens "Beach", presses "Rename", types "Beach 2026", and presses "Save"
  Then the album's heading reads "Beach 2026"
  And the Albums tab shows "Beach 2026" in place of "Beach"
```

- **Notes:** renaming an album changes no photo, and a public link to the album keeps working (PHOTOS-SHARE-040).

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-007] A member whose new album cannot be saved reads why, and keeps the typed name
  Given the member has cloud Photos open on the Albums tab
  And the deployment is too busy to answer at the moment
  When the member presses "New album", types "Summer 2026", and presses "Create"
  Then the form stays open with "Summer 2026" in the name field
  And the form says that the album could not be saved and that the member can try again
```

- **Notes:** Implementation gap: the Albums tab's form shows no message when saving fails. The form stays open with the name, and nothing tells the member that no album was made.

### Adding and removing photos

The member selects photos in the library or in an album, as [photos-library.md](photos-library.md) describes. The bar that a selection raises offers "Add to album…" everywhere. In the library the bar also offers "Share link…". Inside an album the bar offers "Remove from album" and, for one selected photo, "Set as cover".

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-008] A member adds selected photos to an existing album
  Given the member's library holds "a.jpg" and "b.jpg"
  And the member has the empty album "Beach"
  When the member selects both photos, presses "Add to album…", and picks "Beach" in the "Add 2 photos to an album" dialog
  Then the dialog closes and the selection ends
  And the album "Beach" shows both photos and reads "2 photos"
```

- **Notes:** inside an album, the dialog leaves the open album out of its list. Adding a photo that already belongs to the album changes nothing.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-009] A member adds selected photos to a new album named in the same dialog
  Given the member's library holds three photos
  When the member selects the three photos, presses "Add to album…", types "Party" under "New album", and presses "Create and add"
  Then the dialog closes and the selection ends
  And the Albums tab shows "Party" with "3 photos"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-010] A member removes selected photos from an album and still finds them in the library
  Given the member's album "Beach" holds "a.jpg" and "b.jpg"
  When the member opens "Beach", selects "a.jpg", and presses "Remove from album"
  Then the album shows only "b.jpg" and reads "1 photo"
  And the library still shows "a.jpg"
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-011] A member sets one photo as an album's cover
  Given the member's album "Beach" holds three photos, one of them "sunset.jpg"
  When the member opens "Beach", selects "sunset.jpg", and presses "Set as cover"
  Then the Albums tab shows "sunset.jpg" on the card of "Beach"
```

- **Notes:** "Set as cover" appears only while exactly one photo is selected inside an album. An album with no chosen cover shows its newest photo, in the library's order (PHOTOS-SHARE-012).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-012] A member sees an album's cover fall back to its newest photo once the chosen cover leaves the album
  Given the member's album "Beach" shows its chosen cover "sunset.jpg"
  When the member removes "sunset.jpg" from "Beach"
  Then the Albums tab shows the album's most recently taken photo on the card of "Beach"
```

- **Notes:** Photos remembers the choice, so "sunset.jpg" becomes the cover again if the member adds it back.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-013] A member sees an album's photos in the library's order, newest taken first
  Given the member's album "Beach" holds photos taken on three different days
  When the member opens "Beach"
  Then the album shows the photos in the same order as the library, the most recently taken first
```

- **Notes:** an album is the library grid narrowed to the album's photos, so the grid's layout settings apply inside an album too ([photos-library.md](photos-library.md)). An album has no order of its own.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-014] A member who opens an empty album is told how to fill it
  Given the member's album "Beach" holds no photos
  When the member opens "Beach"
  Then the album says "This album is empty. Select photos in the library and choose "Add to album…"."
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-015] A member who adds a photo already in the library still finds it in its albums
  Given the member's album "Beach" holds "beach.jpg"
  When the member adds the same "beach.jpg" file again, with "Add Photo" on a computer or "Upload Photo" in cloud Photos
  Then the album "Beach" still shows "beach.jpg" and reads the same count as before
```

- **Notes:** Photos also says that nothing was added (PHOTOS-IMPORT-003 in [photos-import-and-processing.md](photos-import-and-processing.md)). Implementation gap: after the repeated add, "beach.jpg" drops out of every album on screen until the member reloads the page. The photo stays in its albums, and a reload shows it there again.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-016] A member whose photo is already in 32 albums learns why it cannot join another
  Given the member's photo "beach.jpg" belongs to 32 albums
  And the member's photo "dune.jpg" belongs to no album
  When the member selects both photos, presses "Add to album…", and picks the album "Extra"
  Then Photos says that "beach.jpg" is already in 32 albums, the most a photo can join
  And "Extra" shows "dune.jpg" but not "beach.jpg"
```

- **Notes:** the platform caps one key's values on one record at 32 (SHARED-059 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). Implementation gap: no photo of the selection joins "Extra", and the dialog shows the platform's raw answer, such as `Failed to change the album: {"error":"more than 32 values for key \"album\" on record \"<id>\""}`.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-017] A member whose removal from an album fails is told so
  Given the member has cloud Photos open on the album "Beach", which holds "a.jpg"
  And the deployment is too busy to answer at the moment
  When the member selects "a.jpg" and presses "Remove from album"
  Then Photos says that the photo could not be removed and that the member can try again
  And the album still shows "a.jpg"
```

- **Notes:** Implementation gap: a failed "Remove from album" or "Set as cover" shows no message. The selection stays, and the bar's buttons work again, so the member cannot tell that nothing changed.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-018] A member who adds one photo to two albums on two devices finds it in both
  Given the member has the albums "Beach" and "Summer" on a computer and in cloud Photos
  And the member added "beach.jpg" to "Beach" on the computer while it had no network connection
  And the member added "beach.jpg" to "Summer" in cloud Photos
  And the computer has since reconnected and synced
  When the member reopens Photos on the computer and in cloud Photos
  Then "beach.jpg" appears in both "Beach" and "Summer" on each
```

- **Notes:** each album keeps its own membership, so one addition never overwrites another (SHARED-057 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)).

### Deleting an album

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-019] A member deletes an album after confirming and still finds its photos in the library
  Given the member's album "Beach" holds three photos and has no public link
  When the member opens "Beach", presses "Delete album", and confirms "Delete the album "Beach"? The photos stay in your library."
  Then Photos returns to the Albums tab, which no longer lists "Beach"
  And the library still shows the three photos
```

- **Notes:** cancelling the question keeps the album.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-020] A member who deletes a shared album is warned that its link stops, and finds the link stopped
  Given the member's album "Beach" has a public link
  And the member's Photos can reach the cloud
  When the member opens "Beach", presses "Delete album", and confirms "Delete the album "Beach"? The photos stay in your library. Its public link stops working too."
  Then the Albums tab no longer lists "Beach"
  And the link's address, opened more than a minute later, shows "This link does not exist or was turned off."
```

- **Notes:** the edge cache can answer a stopped link for up to a minute (SHARED-177 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). Photos stops the link before it deletes the album.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-SHARE-021] A member who deletes a shared album on a computer that cannot reach the cloud does not leave the link showing to visitors
  Given the member's album "Beach" has a public link
  And the member's computer has no network connection
  When the member deletes "Beach" in Photos on the computer and confirms
  Then the Albums tab no longer lists "Beach"
  And once the computer reaches the cloud again, the link's address shows "This link does not exist or was turned off."
```

- **Notes:** Implementation gap: Photos deletes the album and leaves the link live. After the computer syncs, the link shows an empty page under the album's old title until the link expires, and Photos never lists the link again. Only a cloud operator can then turn it off, in admin-web's Public Links section (SHARED-179). The same happens on a connected computer whose list of links failed to load.

### Albums across devices and reloads

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-SHARE-022] A member makes and fills an album on a computer with no network connection
  Given the member has Photos open on a computer with no network connection
  When the member makes the album "Trip" and adds two photos to it
  Then "Trip" shows both photos and reads "2 photos"
```

- **Notes:** Photos keeps albums with the library on the computer and syncs them once the computer is back online. Public links still need the cloud (PHOTOS-SHARE-042).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-023] A member finds an album made on the computer in cloud Photos after the computer synced
  Given the member made the album "Trip" with two photos in Photos on a computer
  And the computer has since synced with the cloud
  When the member opens cloud Photos and its Albums tab
  Then the tab shows "Trip" with "2 photos"
```

- **Notes:** the photos' previews must also have reached the cloud for the album's cover to show. The same holds the other way, from cloud Photos to the computer.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-024] A member finds an album deleted on one device gone on the other after reopening Photos
  Given the member deleted the album "Trip" in cloud Photos
  And the member's computer has since synced with the cloud
  When the member reopens Photos on the computer and opens its Albums tab
  Then the tab no longer lists "Trip"
  And the library on the computer still shows the album's photos
```

- **Notes:** Photos keeps a record that the album was deleted, so a device that syncs later learns that the album is gone instead of bringing it back.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-025] A member with Photos open sees an album change made on another device without reloading
  Given the member has Photos open on a computer, showing the album "Trip"
  And the member added "sunset.jpg" to "Trip" in cloud Photos
  And the computer has since synced with the cloud
  When the member keeps looking at "Trip" on the computer
  Then "sunset.jpg" appears in "Trip" without a reload
```

- **Notes:** Implementation gap: Photos reads the album list once per page load, and the library's updates follow changes to photos, not to their albums. A new album, a rename, and a change to an album's photos made on another device show only after the member reloads the page.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-026] A member who reloads the page inside an album comes back to the same album
  Given the member has the album "Trip" open in Photos
  When the member reloads the page
  Then Photos opens the album "Trip" again
```

- **Notes:** Implementation gap: the page's address does not name the open album, so a reload returns to the library, and the browser's Back button does not step out of an album.

## Public links from Photos

A public link lets anyone who holds its address see an album or one photo, without signing in. A visitor sees only display-size copies of the photos, never the originals. Photos keeps one link per album and one per photo, and each link carries a title that visitors see and a lifetime. The platform's rules for every public link, such as who may make one and what a visitor can reach, live in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md) › "Public links". Making or changing a link needs the cloud, so Photos on a computer needs the computer to be signed in and online.

### Opening the link dialog

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-027] A member opens an album's link dialog and reads that anyone with the link sees the album, including photos added later
  Given the member's album "Beach" has no public link
  And the member's Photos can reach the cloud
  When the member opens "Beach" and presses "Public link…"
  Then the dialog "Public link: Beach" says "Anyone with the link can see this album, including photos you add later."
  And the dialog offers "Title visitors see" filled with "Beach", and "Link expires after" set to "30 days"
```

- **Notes:** "Cancel" closes the dialog without making a link, and so do a click outside the dialog and the Escape key.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-028] A member shares the photo open in the viewer as that photo alone
  Given the member has "IMG_0042.jpg" open in the viewer
  When the member presses "Share link…" in the viewer
  Then the dialog "Public link: IMG_0042.jpg" opens over the viewer and says "Anyone with the link can see this photo."
  And "Title visitors see" holds "IMG_0042.jpg"
```

- **Notes:** a photo's link shows that photo alone, never an album it belongs to.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-029] A member who shares one selected photo gets that photo's own link dialog
  Given the member has selected only "a.jpg" in the library
  When the member presses "Share link…" on the selection bar
  Then the selection ends
  And the dialog "Public link: a.jpg" opens for that photo alone, with no album made
```

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-030] A member who shares several selected photos names a new album first, and the link dialog opens for it
  Given the member has selected three photos in the library
  When the member presses "Share link…" on the selection bar, types "Party" in the "Share 3 photos" dialog, and presses "Create album"
  Then Photos opens the album "Party", which reads "3 photos"
  And the dialog "Public link: Party" opens over the album
```

- **Notes:** the "Share 3 photos" dialog explains "A public link shows an album. Name one for these photos, and the link dialog opens next." and lists no existing albums. A link always shows an album or one photo, never a loose selection.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-031] A member who presses Escape in a photo's link dialog returns to the photo in the viewer
  Given the member opened the link dialog with "Share link…" in the viewer on "a.jpg"
  When the member presses the Escape key
  Then the dialog closes
  And the viewer still shows "a.jpg"
```

### Creating and managing a link

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-032] A member creates a link and copies its address
  Given the member has the link dialog of the album "Beach" open, with "Link expires after" at "30 days"
  When the member presses "Create link" and then "Copy"
  Then the dialog shows the link's address and "Expires" with the date 30 days from today, in the member's own time zone
  And the "Copy" button reads "Copied" for two seconds, and the member's clipboard holds the address
```

- **Notes:** in cloud Photos the address is cloud Photos' own address followed by "/p/" and the link's code. The dialog's "Done" button closes it. Opening the address shows the album to anyone (PHOTOS-SHARE-047).

```gherkin
@local @cloud
@intent:confirmed
Scenario Outline: [PHOTOS-SHARE-033] A member chooses a link's lifetime and reads when it expires
  Given the member has the link dialog of the album "Beach" open
  When the member picks "<choice>" under "Link expires after" and presses "Create link"
  Then the dialog reads "<expiry>"

  Examples:
    | choice        | expiry                                  |
    | 1 day         | Expires <tomorrow's date>               |
    | 7 days        | Expires <the date seven days from now>  |
    | 30 days       | Expires <the date 30 days from now>     |
    | 1 year        | Expires <the date 365 days from now>    |
    | Never expires | Never expires                           |
```

- **Notes:** the dialog writes each date in the member's local time zone. The platform's lifetimes are SHARED-143 and SHARED-144 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md).

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-SHARE-034] A member who makes a link on a computer gets an address that opens in cloud Photos
  Given the member's computer is signed in to the member's cloud
  When the member creates a link to the album "Beach" in Photos on the computer
  Then the dialog's address starts with the cloud's public address followed by "/apps/photos/p/"
  And the address shows the album in a browser on any other device
```

- **Notes:** the address never names the computer itself. The computer forwards every link request to the cloud with the computer's own sign-in (SHARED-150).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-035] A member sees the "Public link" mark on albums whose link still opens
  Given the member's album "Beach" has a link that expires next week
  And the member's album "Garden" has a link that expired yesterday
  And the member's album "Trip" has no link
  When the member opens the Albums tab
  Then only "Beach" shows the "Public link" mark
  And the heading of "Beach" shows the mark when the member opens it
```

- **Notes:** the mark's tooltip reads "Shared by public link". When Photos cannot reach the cloud, no album shows the mark.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-036] A member changes a link's lifetime, counted from the change
  Given the member made a 7-day link to the album "Beach" five days ago
  When the member opens the link dialog and picks "7 days" under "Lifetime from now"
  Then the dialog reads "Expires" with the date seven days from today
  And the dialog shows the same address as before
```

- **Notes:** the platform's rule is SHARED-146 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-037] A member brings an expired link back by choosing a new lifetime
  Given the member's link to the album "Beach" expired yesterday
  When the member opens the link dialog and picks "30 days" under "Lifetime from now"
  Then the dialog reads "Expires" with the date 30 days from today, where it read "Expired" in red
  And the link's old address shows the album again
```

- **Notes:** an expired link keeps its address until the member stops it, so a visitor who kept the address sees the album again.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-038] A member replaces a link after confirming, and the old address stops working
  Given the member's album "Beach" has a public link
  When the member opens the link dialog, presses "Replace link", and confirms "Replace the link? The current link stops working, and the album is shared at a new one."
  Then the dialog shows a new address with the same expiry
  And the old address, opened more than a minute later, shows "This link does not exist or was turned off."
```

- **Notes:** a photo's link asks "Replace the link? The current link stops working, and the photo is shared at a new one." The platform's rule is SHARED-147.

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-039] A member stops sharing after confirming, and the album loses its mark
  Given the member's album "Beach" has a public link
  When the member opens the link dialog, presses "Stop sharing", and confirms "Stop sharing? Anyone holding the link loses access."
  Then the dialog offers "Create link" again
  And "Beach" no longer shows the "Public link" mark
  And the old address, opened more than a minute later, shows "This link does not exist or was turned off."
```

- **Notes:** a page or photo a visitor already loaded can keep showing for up to an hour (SHARED-177).

```gherkin
@local @cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-040] A member who renames a shared album keeps the link working
  Given the member's album "Beach" has a public link
  When the member renames the album to "Beach 2026"
  Then the link's address still shows the album's photos
```

- **Notes:** a link follows the album itself, not its name, so a rename never breaks a link. Visitors keep seeing the title the link was given (PHOTOS-SHARE-041).

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-041] A member changes the title visitors see on an existing link
  Given the member's album "Beach" has a public link titled "Beach"
  When the member opens the link dialog, changes "Title visitors see" to "Summer", and saves the change
  Then the link's address shows the title "Summer"
  And the address stays the same
```

- **Notes:** Implementation gap: the dialog of an existing link offers no title field, so the title visitors see stays the one the member typed at creation. The platform accepts a new title (SHARED-146).

### When links are unavailable

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-SHARE-042] A member on a computer that is not signed in is told links need the cloud, and how to sign in
  Given the member's computer has joined a cloud but is not signed in
  When the member opens the link dialog of the album "Beach"
  Then the dialog says "Public links need the cloud, and Photos cannot reach it right now."
  And the dialog shows "This machine is not signed in to the cloud yet — sign in from admin-web" and a "Try again" button
```

- **Notes:** once the local operator signs the computer in from admin-web's This Machine card (ACCESS-062), "Try again" brings the dialog's "Create link" form. Albums keep working while links are unavailable.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-SHARE-043] A member on a computer with no cloud is told plainly that public links need one
  Given the member's computer has never joined a cloud
  When the member opens the link dialog of the album "Beach"
  Then the dialog says that public links need a Starkeep cloud, and that this computer is not connected to one
  And the dialog offers no "Try again" button
```

- **Notes:** Implementation gap: the dialog says "Public links need the cloud, and Photos cannot reach it right now.", shows the technical line "Cloud is not configured (no apiGatewayUrl / STARKEEP_CLOUD_URL)", and offers "Try again", which can never succeed.

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-SHARE-044] A member whose Photos was never approved to publish is told whom to ask
  Given the cloud operator installed Photos in the cloud from an older build that did not ask to publish public links
  And the member's computer, signed in to that cloud, runs a current Photos
  When the member opens the link dialog of the album "Beach" on the computer
  Then the dialog says that Photos may not publish public links on this deployment
  And the dialog tells the member to ask whoever manages the deployment to reinstall Photos and approve public links
```

- **Notes:** a cloud operator who redeploys the current Photos to the cloud approves public links at that install. An album or photo that already has a link still shows it, so the member can stop it. Implementation gap: the dialog says "Photos was not approved to publish public links when it was installed. Reinstall it from admin-web and approve public links to turn this on.", which asks a member to use admin-web, where only a cloud operator can sign in and install Photos in the cloud.

### What the dialog promises

```gherkin
@local
@intent:unclear
Scenario: [PHOTOS-SHARE-045] A member making a link on a computer is told that photos added there appear after they sync
  Given the member's computer is signed in to the member's cloud
  When the member opens the link dialog of the album "Beach" in Photos on the computer
  Then the dialog says "Photos added on this computer appear in the link after they sync."
```

- **Notes:** a visitor sees a photo only once its display-size copies have reached the cloud (SHARED-155). Implementation gap: the dialog has no such line.

```gherkin
@local @cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-046] A member making a link is told that visitors can save the photos they see
  Given the member's album "Beach" has no public link
  When the member opens the link dialog of "Beach"
  Then the dialog says that visitors can save any photo they see, although the page offers no download button
```

- **Notes:** Implementation gap: the dialog says only "Anyone with the link can see this album, including photos you add later."

## What a visitor sees

A link's address opens Photos' visitor page in the cloud. The page needs no sign-in and loads nothing of the signed-in app. The page shows the link's title and display-size copies of the photos, and never shows dates, captions, menus, or a download button. The page also asks search engines not to list it, and sends no referrer to other sites.

### An album's page

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-047] A visitor opens an album link without signing in and sees its title, item count, and photos
  Given a member made a public link titled "Beach" to an album of 12 photos
  When a visitor opens the link's address in a browser that has never signed in to the deployment
  Then the page shows "Beach", "12 items", and the 12 photos in rows
  And the browser tab reads "Beach"
  And the page shows no sign-in prompt, dates, captions, or download button
```

- **Notes:** the photos appear newest taken first. What the page may reveal, and that it never reaches an original, is the platform's rule (SHARED-152 in starkeep-core's [shared-data.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/shared-data.md)). On a phone-width screen the rows run edge to edge and are shorter.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-048] A visitor opens a photo large, steps through the album with the arrow keys, and closes it
  Given a visitor has an album link's page open
  When the visitor clicks the album's second photo, presses the right arrow key, and then presses Escape
  Then the second photo fills the screen, and the right arrow key shows the third photo in its place
  And Escape returns the visitor to the album's rows
```

- **Notes:** the large view also offers "‹" and "›" buttons and a "×" button, and a click beside the photo closes it. The first photo has no "‹" button, and the last has no "›" button.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-049] A visitor plays a video from the album
  Given a member's shared album holds a video
  When a visitor opens the album link and clicks the video, which shows a play mark
  Then the video's playable copy starts on its own, over its poster frame, with the browser's playback controls
```

- **Notes:** a visitor never receives the video's original (SHARED-153).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-050] A visitor sees "N+ items" while more of a large album loads on scrolling, then the exact count
  Given a member made a public link to an album of 150 photos
  When a visitor opens the link
  Then the page reads "60+ items"
  And after the visitor scrolls to the end of the album, the page reads "150 items"
```

- **Notes:** the page loads 60 photos at a time, each time the visitor nears the end. An album above 2,000 photos is SHARED-159.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-051] A visitor whose next photos of an album fail to load still gets the rest of the album
  Given a visitor has the page of a 150-photo album open, reading "60+ items"
  And the visitor's network connection dropped for a moment as the next photos loaded
  When the visitor waits at the end of the shown photos once the connection works again
  Then the rest of the album loads without a reload
  And the page says that more photos could not be loaded only if they still fail after a short while
```

- **Notes:** Implementation gap: the page shows the photos it has, keeps reading "60+ items", and asks for the next photos again only when the visitor scrolls away from the end and back, or reloads the page.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-052] A visitor who keeps an album page open past an hour still sees its photos load
  Given a visitor opened an album link's page more than an hour ago and has not scrolled to its end
  When the visitor scrolls down or opens a photo large
  Then every photo the visitor reaches loads
```

- **Notes:** Implementation gap: each photo's address on the page works for one hour, so photos the visitor reaches after that show as broken images until the visitor reloads the page.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-053] A visitor of an album whose photos are all still uploading is told how many are on their way
  Given a member added five photos to a new album on a computer and made a public link to it
  And none of the photos' display-size copies has reached the cloud yet
  When a visitor opens the link
  Then the page says that five photos are still uploading, and to try again in a few minutes
```

- **Notes:** a photo appears once its display-size copies reach the cloud (SHARED-155). Implementation gap: the page shows the album's title and "0 items" with no explanation.

### A photo's page

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-054] A visitor of a photo link sees the photo large under its title, with no grid and no close button
  Given a member made a public link titled "Sunset" to one photo
  When a visitor opens the link
  Then the photo fills the screen, with "Sunset" in the screen's upper left corner
  And the page shows no grid, no "×" button, and no arrows
```

- **Notes:** the platform's side of a record link is SHARED-161.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-055] A visitor of a photo link whose photo is still uploading is told to try again in a few minutes
  Given a member made a public link to a photo whose display-size copies have not reached the cloud yet
  When a visitor opens the link
  Then the page says "This photo is still uploading. Try again in a few minutes."
```

- **Notes:** the platform's side is SHARED-175.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-056] A visitor of a photo link whose photo was deleted is told the link shows nothing
  Given a member made a public link to a photo and then deleted the photo
  When a visitor opens the link
  Then the page says "This link no longer shows anything."
```

- **Notes:** the platform's side is SHARED-171.

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-060] A visitor of a link to one video plays it at once
  Given a member made a public link to one video
  When a visitor opens the link
  Then the video's playable copy starts on its own, over its poster frame, with the browser's playback controls
```

- **Notes:** most browsers refuse to start a video with sound on a page the visitor has not yet clicked, and then show the poster frame with the playback controls. A click on a video in an album's page counts as such a click (PHOTOS-SHARE-049).

### Links that do not open

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [PHOTOS-SHARE-057] A visitor of an expired, stopped, or unknown link reads why it does not open
  Given a visitor holds <link>
  When the visitor opens it
  Then the page says "<message>"

  Examples:
    | link                                                          | message                                     |
    | a link past its expiry                                        | This link has expired.                      |
    | a link the member stopped, more than a minute ago             | This link does not exist or was turned off. |
    | a link whose album the member deleted, more than a minute ago | This link does not exist or was turned off. |
    | a well-formed address that no link ever had                   | This link does not exist or was turned off. |
```

- **Notes:** the platform's answers are SHARED-170. A visitor never learns whether a link was stopped or never existed.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-058] A visitor of a malformed link address is told the link is not valid
  Given a visitor holds a link address whose code lost its last characters when it was copied
  When the visitor opens it
  Then the page says "This link is not valid."
```

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-059] A visitor whose link page cannot load right now gets it once the connection works
  Given a visitor opens a member's public link to one photo
  And the visitor's network connection drops as the page loads
  When the visitor waits for the page
  Then the page tries again on its own and shows the photo once the connection works
  And the page says "This link could not be loaded. Try again in a moment." only if it still cannot load after a short while
```

- **Notes:** the same holds for an album's link. Implementation gap: the page asks once, and then says "This album could not be loaded. Try again in a moment." for every link, a photo's link included.

### Link previews

```gherkin
@cloud
@intent:unclear
Scenario: [PHOTOS-SHARE-061] A member who pastes an album link into a chat sees the album's title in the link preview
  Given the member made a public link titled "Beach" to an album
  When the member pastes the link's address into a chat app that shows link previews
  Then the preview names "Beach"
  And the preview shows one of the album's photos
```

- **Notes:** a chat app keeps its own copy of the preview image, which outlives "Stop sharing". Implementation gap: every link's preview reads "Photos" and shows no image.

## Cloud-served Photos

In the cloud, Photos lives at the deployment's address under `/apps/photos`, and the member signs in to it as [photos-library.md](photos-library.md) describes. Cloud Photos shows the member's library from the cloud, makes the previews the screen needs ([photos-import-and-processing.md](photos-import-and-processing.md)), and offers albums and public links as Photos on a computer does. Face recognition runs only on a computer ([photos-people.md](photos-people.md)). How the platform hosts an app under its mount is CLOUD-RUN-039 and CLOUD-RUN-040 in starkeep-core's [cloud-runtime.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/cloud-runtime.md).

### Photos at its cloud address

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-062] A member uses every part of cloud Photos at its address under "/apps/photos"
  Given the member is signed in to cloud Photos at the deployment's address followed by "/apps/photos"
  When the member opens the library, the Albums tab, an album, and the album's link dialog
  Then each screen shows the member's photos, albums, and links
  And no screen shows a "Not Found" answer or an empty result in place of the member's data
```

- **Notes:** every call Photos' page makes to its own server goes under "/apps/photos". The visitor page's one call goes to the deployment's root instead, because the platform answers it (PHOTOS-SHARE-047). A signed-out visit to any page but a link's page leads to sign-in (ACCESS-028 in starkeep-core's [users-and-access.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/users-and-access.md)).

```gherkin
@cloud
@intent:confirmed
Scenario Outline: [PHOTOS-SHARE-063] A member finds a change made in cloud Photos still there after a reload
  Given the member is signed in to cloud Photos, whose library holds photos and the album "Beach"
  When the member <change>
  And the member reloads the page
  Then cloud Photos shows <result>

  Examples:
    | change                                                 | result                                   |
    | writes the caption "Harbour" in a photo's info panel   | the caption "Harbour" on that photo      |
    | deletes a photo from the viewer                        | the library without that photo           |
    | renames the album "Beach" to "Beach 2026"              | the album "Beach 2026"                   |
```

- **Notes:** each change in cloud Photos is saved as the signed-in member, so it lands in the member's own library and syncs to the member's other devices. A request without a sign-in gets nothing (ACCESS-048). How captions and deleting work is [photos-library.md](photos-library.md)'s.

### Photos still uploading from another device

A phone sends a photo's record to the cloud before the photo's files, and uploads the files afterward, the smallest first ([uploads-and-file-bytes.md](https://github.com/starkeep-org/starkeep-core/blob/main/scenarios/uploads-and-file-bytes.md)). Cloud Photos therefore lists photos whose files are still on the phone. Cloud Photos waits for those files instead of trying to make them itself. The general tile states are PHOTOS-IMPORT-025 to PHOTOS-IMPORT-032 in [photos-import-and-processing.md](photos-import-and-processing.md).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-064] A member sees a photo from the phone at a smaller size first, then sharp once the phone uploads the larger size
  Given the member's phone has uploaded a photo's smallest preview but not the larger preview that the photo's tile needs
  When the member scrolls the photo into view in cloud Photos
  Then the tile shows the smallest preview at once
  And the tile switches to the larger preview once the phone has uploaded it, without a reload
```

- **Notes:** cloud Photos does not make the larger size itself while the phone's copy is on its way. When the original has reached the cloud and no device made the size, cloud Photos makes it (PHOTOS-IMPORT-031).

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-065] A member sees a spinner on a photo whose files are all still on the phone, then its thumbnail once the phone uploads it
  Given the member's phone has sent a photo larger than 512 KB to the cloud, but none of its files yet
  When the member scrolls the photo into view in cloud Photos
  Then the tile shows a spinner and no broken-image icon
  And the tile shows the photo's thumbnail once the phone has uploaded it, without a reload
```

- **Notes:** when the phone already sent the photo's colours and shape, the blurred version shows under the spinner (PHOTOS-IMPORT-025). Cloud Photos keeps asking at a growing interval of up to one minute.

```gherkin
@cloud
@intent:confirmed
Scenario: [PHOTOS-SHARE-066] A member sees a spinner, not "Cannot be displayed", on a phone's HEIC photo whose previews are still uploading
  Given the member's phone made previews of a HEIC photo, and none of them has reached the cloud yet
  When the member scrolls the photo into view in cloud Photos
  Then the tile shows a spinner, not "Cannot be displayed"
  And the tile shows the phone's thumbnail once the phone has uploaded it, without a reload
```

- **Notes:** cloud Photos cannot read HEIC photos itself, so a HEIC photo that no device made previews for shows "Cannot be displayed" (PHOTOS-IMPORT-036).

## Photos' log

```gherkin
@local
@intent:confirmed
Scenario: [PHOTOS-SHARE-067] A local operator reading Photos' log on the computer sees each line stamped with local time and its UTC offset
  Given the local operator started Photos from admin-web on a computer set to UTC−5
  When the local operator opens Photos' log file "~/.starkeep/pids/photos.log"
  Then each line Photos wrote starts with the computer's local time and its offset, such as "2026-11-24T14:05:00.123-05:00"
```

- **Notes:** the local data server stamps its log the same way, so the two logs read side by side. A line from Photos' background workers carries the stamp too, and a line never carries two stamps.
