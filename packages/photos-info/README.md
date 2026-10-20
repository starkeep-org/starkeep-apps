# @starkeep/photos-info

The rows a photo's info panel shows, and how each value is formatted.

## Why this is a package

The desktop viewer's info panel and the phone's info sheet show the same facts
about a photo. Each surface reads those facts from a different place: the
desktop from its `AppImage`, the phone from the record and its metadata row. The
list of rows, their order and their formatting must not differ between the two,
so both surfaces build the list with `photoInfoRows` from this package.

## What is in here

- `photoInfoRows(fields)` turns a photo's facts into labelled rows, omitting
  every row whose value is missing.
- `formatBytes`, `formatMegapixels` and `formatOrientation` format single
  values.
