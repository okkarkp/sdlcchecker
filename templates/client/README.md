# Client deliverable templates

Drop the client's branded templates here and `/publish` will make deliverables come out in
**their** house style — fonts, colours, headers/footers, cover page, sheet layout. If this
folder is empty, `/publish` falls back to the clean default styling in `../deliverables/`.

## What to drop in

| File (exact name) | Used for | How it's applied |
| --- | --- | --- |
| `report-template.docx` | Word / PDF deliverables (design, architecture, UI-flow, compliance) | Used as pandoc's **reference document** — your styles, headings, header/footer and cover are inherited. |
| `workbook-template.xlsx` | Excel deliverables (stories, test cases, traceability) | `/publish` fills its **named sheets and column headers** instead of creating a bare workbook. |

Both are optional and independent — add just the Word one, just the Excel one, or both.

## Making a `report-template.docx`
1. Open a document in the client's Word template (or a signed-off past deliverable).
2. Make sure its built-in styles are set the way you want: `Title`, `Heading 1`–`Heading 3`,
   `Normal`, `Table` (pandoc maps markdown to these).
3. Delete the body text — keep the styles, cover page, and header/footer. Save as
   `report-template.docx` here.

## Making a `workbook-template.xlsx`
1. Create the sheets you want, named exactly: `User Stories`, `Test Cases`, `Traceability`.
2. Put the column headers in row 1 (any branding/logo above is fine — data starts below the
   header row). `/publish` writes rows under the matching headers.

## Notes
- Nothing here is committed with real client branding by default — treat client templates as
  engagement assets, not repo content, and follow your project's handling rules.
- `/publish` never edits these templates; it only reads them to style the output.
