# Default deliverable styling

`/publish` uses clean default styling when no client template is present in `../client/`. It
keeps deliverables neat and readable without any client branding.

**No binary default assets are needed here.** The `deliverables-packager` renders output with
whatever is on the machine — pandoc's own clean defaults for Word/PDF, openpyxl's for Excel,
and plain CSV/HTML when neither is installed (the offline path).

To brand the output, don't add anything here — drop the client's `report-template.docx` /
`workbook-template.xlsx` into `../client/` (see that folder's README). If you want a house
default, you *may* add `reference.docx` / `workbook.xlsx` here and the packager will use them,
but it is optional.
