import { getTierRows } from "./google-sheet.js";

const rows = await getTierRows();

console.log("Rows found:", rows.length);
console.log("First row:", rows[0]);