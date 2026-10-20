# @starkeep/photos-info

The rows a photo's info panel shows, and how each value is formatted.

## Why this is a package

The Photos web app's info panel and the phone's info sheet show the same facts
about a photo. Each surface reads those facts from a different place: the web
app from its `AppImage`, the phone from the record and its metadata row. The
list of rows, their order and their formatting must not differ between the two,
so both surfaces build the list with `photoInfoRows` from this package.

Only the rows are shared. Each surface draws them with its own components.

## What is in here

- `photoInfoRows(fields, options)` turns a photo's facts into labelled rows. It
  omits every row whose value is missing, unless `keepCoreRows` asks it to keep
  filename, dimensions, MIME type, file size and date taken with a blank value.
  The web app's panel passes `keepCoreRows`.
- `formatBytes`, `formatMegapixels` and `formatOrientation` format single
  values.
