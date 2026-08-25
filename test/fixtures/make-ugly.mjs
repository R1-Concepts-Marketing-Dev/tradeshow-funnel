// Builds the kind of file an organizer actually sends: logo rows, a report
// stamp, a blank line, THEN headers — and three sheets, only one with people.
// Run: node test/fixtures/make-ugly.mjs
import * as XLSX from "xlsx";
import fs from "node:fs";

// The ESM build has no filesystem access until you hand it one.
XLSX.set_fs(fs);
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const attendees = [
  ["", "", "", "", ""],
  ["SEMA 2026 — EXHIBITOR LEAD REPORT", "", "", "", ""],
  ["Generated 2026-11-08 09:14 PST", "", "", "", ""],
  ["", "", "", "", ""],
  ["Attendee Email", "First Name", "Last Name", "Company", "Mobile"],
  ["a.rivera@torqueautoworks.com", "Ana", "Rivera", "Torque Autoworks", "5554412210"],
  ["m.chen@apexfleet.com", "Min", "Chen", "Apex Fleet", "5557783311"],
  ["", "", "", "", ""],
  ["p.walsh@gmail.com", "Pat", "Walsh", "Walsh Brake", "5552209987"],
  ["sales@torqueautoworks.com", "", "", "Torque Autoworks", ""],
];
const summary = [["Metric", "Value"], ["Total scans", 412], ["Unique", 388]];
const legend = [["Code", "Meaning"], ["A", "Buyer"], ["B", "Press"]];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(legend), "Legend");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(attendees), "Lead Detail");

const out = path.join(here, "ugly-roster.xlsx");
XLSX.writeFile(wb, out);
console.log("wrote", out);
